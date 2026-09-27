"""Data-only optional configuration, with a single atomic activation point."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import urllib.parse
import urllib.request

import yaml

MANIFEST_LIMIT = 64 * 1024
PERSONA_LIMIT = 256 * 1024
DEFAULTS = Path('/opt/agent-box/defaults')


def relative_path(value):
    if not isinstance(value, str) or len(value) > 1024 or len(value.split('/')) > 16 or not all(
        re.fullmatch(r'[a-zA-Z0-9_][a-zA-Z0-9_.-]*', part) for part in value.split('/')
    ):
        raise ValueError('Invalid relative path')
    return value


def settings(data):
    """Mirror ConfigSourceSettingsSchema; reject unknown keys, including hooks/secrets."""
    if not isinstance(data, dict) or set(data) - {'schemaVersion', 'flavor', 'identity', 'hermes', 'persona'}:
        raise ValueError('Invalid settings')
    if type(data.get('schemaVersion')) is not int or data['schemaVersion'] != 1 or data.get('flavor') != 'hermes':
        raise ValueError('Invalid version or flavor')
    for key, field, limit in [('identity', 'name', 128), ('hermes', 'model', 256),
                              ('persona', 'instructionsFile', 1024)]:
        if key not in data:
            continue
        obj = data[key]
        if not isinstance(obj, dict) or set(obj) != {field}:
            raise ValueError('Invalid setting')
        value = obj[field]
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= limit:
            raise ValueError('Invalid setting value')
        if key == 'persona':
            relative_path(value)
        else:
            obj[field] = value.strip()
    return data


class StrictLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        result = super().construct_mapping(node, deep=deep)
        if len(result) != len(node.value):
            raise ValueError('Duplicate manifest key')
        return result

    def compose_node(self, parent, index):
        # Aliases/anchors are unnecessary for this small schema and permit expansion attacks.
        if self.check_event(yaml.AliasEvent) or getattr(self.peek_event(), 'anchor', None):
            raise ValueError('YAML references are not supported')
        if len(self.states) > 20:
            raise ValueError('Manifest nesting limit')
        return super().compose_node(parent, index)


def parse_manifest(raw):
    if len(raw) > MANIFEST_LIMIT:
        raise ValueError('Manifest too large')
    return settings(yaml.load(raw.decode('utf-8'), Loader=StrictLoader))


def local_read(root, name, limit):
    root = Path(root).resolve(strict=True)
    path = root / relative_path(name)
    # Disallow symlinks in every component, even when they point back into the mount.
    current = root
    for part in Path(name).parts:
        current /= part
        if current.is_symlink():
            raise ValueError('Symlink config file')
    if not path.resolve(strict=True).is_relative_to(root) or not path.is_file():
        raise ValueError('Invalid config file')
    with path.open('rb') as stream:
        value = stream.read(limit + 1)
    if len(value) > limit:
        raise ValueError('Config file too large')
    value.decode('utf-8')
    return value


def source_repo(source):
    match = re.fullmatch(r'github:(user|org|repo)/([A-Za-z0-9][A-Za-z0-9-]{0,38})(?:/([A-Za-z0-9_.-]{1,100}))?', source)
    if not match:
        raise ValueError('Invalid GitHub source')
    kind, owner, repo = match.groups()
    if (kind == 'repo') != (repo is not None) or repo in {'.', '..'}:
        raise ValueError('Invalid GitHub source')
    return f'{owner}/{repo if kind == "repo" else owner if kind == "user" else ".github"}'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError('Redirect rejected')


class GitHub:
    def __init__(self, token_file=None):
        self.token = Path(token_file).read_text().strip() if token_file else None
        self.opener = urllib.request.build_opener(NoRedirect)
        self.trees = {}

    def request(self, path):
        headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'mindi-config-source',
                   'X-GitHub-Api-Version': '2022-11-28'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        req = urllib.request.Request('https://api.github.com/repos/' + path, headers=headers)
        with self.opener.open(req, timeout=10) as response:
            value = response.read(1024 * 1024 + 1)
        if len(value) > 1024 * 1024:
            raise ValueError('Response too large')
        return json.loads(value)

    def resolve(self, repo, ref):
        if not isinstance(ref, str) or not re.fullmatch(r'[A-Za-z0-9_./-]{1,200}', ref):
            raise ValueError('Invalid ref')
        if re.fullmatch('[a-f0-9]{40}', ref):
            return ref
        result = self.request(f'{repo}/commits/{urllib.parse.quote(ref, safe="")}')
        sha = result.get('sha')
        if not isinstance(sha, str) or not re.fullmatch('[a-f0-9]{40}', sha):
            raise ValueError('Invalid commit')
        return sha

    def read(self, repo, sha, path, limit):
        relative_path(path)
        # Contents API dereferences some symlinks. Inspect Git modes instead.
        tree_sha = self.request(f'{repo}/git/commits/{sha}')['tree']['sha']
        parts = path.split('/')
        for index, part in enumerate(parts):
            if not re.fullmatch('[a-f0-9]{40}', tree_sha):
                raise ValueError('Invalid object hash')
            cache_key = (repo, tree_sha)
            if cache_key not in self.trees:
                self.trees[cache_key] = self.request(f'{repo}/git/trees/{tree_sha}')
            tree = self.trees[cache_key]
            if tree.get('truncated'):
                raise ValueError('Truncated tree')
            entry = next(item for item in tree['tree'] if item['path'] == part)
            final = index == len(parts) - 1
            if entry.get('mode') != ('100644' if final else '040000') or entry.get('type') != ('blob' if final else 'tree'):
                raise ValueError('Only non-executable regular config files allowed')
            tree_sha = entry['sha']
        if not re.fullmatch('[a-f0-9]{40}', tree_sha):
            raise ValueError('Invalid blob hash')
        if type(entry.get('size')) is not int or not 0 <= entry['size'] <= limit:
            raise ValueError('Invalid remote size')
        result = self.request(f'{repo}/git/blobs/{tree_sha}')
        if result.get('encoding') != 'base64' or result.get('size') != entry['size']:
            raise ValueError('Invalid remote file')
        value = base64.b64decode(result['content'].replace('\n', ''), validate=True)
        if len(value) > limit or len(value) != result['size']:
            raise ValueError('Invalid remote size')
        value.decode('utf-8')
        return value


def bundle(read, path):
    config = parse_manifest(read(path, MANIFEST_LIMIT))
    persona = None
    if 'persona' in config:
        # Persona paths are relative to the manifest directory.
        name = str(Path(path).parent / config['persona']['instructionsFile'])
        persona = read(name, PERSONA_LIMIT).decode('utf-8')
    return {'settings': config, 'persona': persona}


def atomic_json(path, value):
    fd, temporary = tempfile.mkstemp(prefix='.write-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, sort_keys=True)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def activate(state, name):
    link = state / '.next'
    link.unlink(missing_ok=True)
    link.symlink_to(name)
    os.replace(link, state / 'current')


def load_snapshot(state):
    current = state / 'current'
    if not current.is_symlink():
        return None
    name = os.readlink(current)
    if not re.fullmatch(r'revision-[a-zA-Z0-9_-]+', name):
        raise ValueError('Invalid active revision')
    return json.loads((state / name / 'snapshot.json').read_text())


def apply(home, defaults=DEFAULTS, source=None, ref=None, manifest='agent-box.yaml',
          local=None, required=False, refresh=False, rollback=False, github=None, token_file=None):
    root = Path(home)
    if root.is_symlink():
        raise ValueError('Invalid home')
    root.mkdir(parents=True, exist_ok=True)
    profiles = root / 'profiles'
    if profiles.is_symlink() or (profiles.exists() and any(profiles.iterdir())):
        raise ValueError('Only one profile supported')
    state = root / '.agent-box'
    if state.is_symlink():
        raise ValueError('Invalid state directory')
    state.mkdir(mode=0o700, exist_ok=True)
    lock = state / 'lock'
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        return _apply(root, state, defaults, source, ref, manifest, local, required,
                      refresh, rollback, github, token_file)


def _apply(root, state, defaults, source, ref, manifest, local, required, refresh, rollback, github, token_file):
    old = load_snapshot(state)
    if rollback:
        previous = old.get('previous') if old else None
        if not previous or not re.fullmatch(r'revision-[a-zA-Z0-9_-]+', previous):
            raise ValueError('No previous revision')
        status = json.loads((state / previous / 'snapshot.json').read_text())['status']
        activate(state, previous)
        atomic_json(state / 'status.json', status)
        return status
    selection = {'source': source, 'ref': ref, 'manifest': manifest}
    remote = None
    degraded = False
    try:
        if source:
            repo = source_repo(source)
            relative_path(manifest)
            if not ref:
                raise ValueError('Explicit ref required')
            if old and old.get('selection') == selection and old.get('remote') and not refresh:
                remote = old['remote']
            else:
                github = github or GitHub(token_file)
                sha = github.resolve(repo, ref)
                remote = bundle(lambda name, limit: github.read(repo, sha, name, limit), manifest)
                remote.update(source=source, commit=sha)
        elif required:
            raise ValueError('Required source missing')
    except Exception:
        # Never persist or print transport exception text, URLs, response bodies or tokens.
        if required:
            raise ValueError('Required config source unavailable (details redacted)') from None
        degraded = True
        selection = old['selection'] if old else {'source': None, 'ref': None, 'manifest': 'agent-box.yaml'}
        remote = old.get('remote') if old and source else None
    base = json.loads(local_read(defaults, 'agent-box.json', MANIFEST_LIMIT))
    persona = local_read(defaults, base['persona']['instructionsFile'], PERSONA_LIMIT).decode('utf-8')
    effective = {'identity': base['identity']}
    if base.get('hermes'):
        effective['hermes'] = base['hermes']
    local_bundle = bundle(lambda name, limit: local_read(local, name, limit), 'agent-box.yaml') if local else None
    for layer in [remote, local_bundle]:
        if layer:
            for key in ('identity', 'hermes'):
                if key in layer['settings']:
                    effective[key] = layer['settings'][key]
            if layer['persona'] is not None:
                persona = layer['persona']
    # Preserve operator-owned runtime fields. Remote data can only set model/persona.
    if old:
        config = old['operator']
    else:
        path = root / 'config.yaml'
        if path.is_symlink() or (root / 'AGENTS.md').is_symlink():
            raise ValueError('Unmanaged symlink')
        config = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(config, dict):
        raise ValueError('Invalid operator config')
    operator = dict(config)
    config = dict(config)
    tools = config.get('toolsets', [])
    computer = config.get('computer_use', {})
    if not isinstance(tools, list) or not all(isinstance(x, str) for x in tools) or not isinstance(computer, dict):
        raise ValueError('Invalid operator config')
    config['toolsets'] = list(dict.fromkeys([*tools, 'computer_use']))
    config['computer_use'] = {**computer, 'grant_existing_profile': True}
    if 'hermes' in effective:
        config['model'] = effective['hermes']['model']
    # Existing local Hermes settings/personality have highest precedence on migration.
    if 'model' in operator and not (local_bundle and 'hermes' in local_bundle['settings']):
        config['model'] = operator['model']
    local_persona = old.get('operatorPersona') if old else (
        (root / 'AGENTS.md').read_text() if (root / 'AGENTS.md').exists() else None)
    if local_persona is not None and not local:
        persona = local_persona
    digest = hashlib.sha256(json.dumps({'effective': effective, 'config': config, 'persona': persona}, sort_keys=True).encode()).hexdigest()
    status = {'state': 'degraded' if degraded else 'ready', 'source': remote['source'] if remote else 'defaults',
              'commit': remote['commit'] if remote else None, 'contentHash': 'sha256:' + digest,
              'localOverride': bool(local), 'reason': 'optional-source-unavailable' if degraded else None}
    if old and old['status']['contentHash'] == status['contentHash'] and old['selection'] == selection and old['remote'] == remote:
        atomic_json(state / 'status.json', status)
        return status
    snapshot = {'selection': selection, 'remote': remote, 'operator': operator, 'operatorPersona': local_persona,
                'effective': effective, 'status': status,
                'previous': os.readlink(state / 'current') if old else None}
    revision = Path(tempfile.mkdtemp(prefix='revision-', dir=state))
    try:
        atomic_json(revision / 'config.yaml', config)
        atomic_json(revision / 'snapshot.json', snapshot)
        atomic_json(revision / 'status.json', status)
        (revision / 'AGENTS.md').write_text(persona)
        (revision / 'AGENTS.md').chmod(0o600)
        if not old:
            # Initial migration publishes the saved operator data before replacing files.
            # An interrupted migration can resume from this complete snapshot.
            activate(state, revision.name)
        # Install stable links only during first boot/migration, before any services start.
        for name in ('config.yaml', 'AGENTS.md'):
            target = root / name
            expected = f'.agent-box/current/{name}'
            if target.is_symlink():
                if os.readlink(target) != expected:
                    raise ValueError('Unmanaged symlink')
            else:
                link = root / f'.{name}.next'
                link.symlink_to(expected)
                os.replace(link, target)
        if old:
            activate(state, revision.name)
        atomic_json(state / 'status.json', status)
    except Exception:
        if not (state / 'current').is_symlink() or os.readlink(state / 'current') != revision.name:
            shutil.rmtree(revision)
        raise
    return status


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['boot', 'refresh', 'rollback', 'status'], nargs='?', default='boot')
    args = parser.parse_args()
    try:
        home = os.environ['HERMES_HOME']
        if args.action == 'status':
            print((Path(home) / '.agent-box/status.json').read_text())
            return
        status = apply(home, source=os.environ.get('AGENT_BOX_CONFIG_SOURCE'),
                       ref=os.environ.get('AGENT_BOX_CONFIG_REF'),
                       manifest=os.environ.get('AGENT_BOX_CONFIG_MANIFEST', 'agent-box.yaml'),
                       local=os.environ.get('AGENT_BOX_CONFIG_LOCAL'),
                       token_file=os.environ.get('AGENT_BOX_CONFIG_TOKEN_FILE'),
                       required=os.environ.get('AGENT_BOX_CONFIG_REQUIRED', 'false') == 'true',
                       refresh=args.action == 'refresh', rollback=args.action == 'rollback')
        print(json.dumps(status))
    except Exception:
        raise SystemExit('agent-box: config activation failed (details redacted)') from None


if __name__ == '__main__':
    main()
