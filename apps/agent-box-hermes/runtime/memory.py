"""Embedded Hindsight lifecycle; only the service receives inference credentials."""
import json
import os
from pathlib import Path
import sys
import uuid

DATA = Path('/var/lib/agent-box/hindsight')
RUNTIME = Path('/run/user/1000/memory')
SECRET_NAMES = ('memory_llm_key', 'memory_embeddings_key')


def secret(path, name):
    try:
        value = path.read_text().rstrip('\r\n')
    except OSError:
        raise ValueError(f'memory: missing runtime secret {name}') from None
    if not value or len(value) > 8192 or any(c in value for c in '\r\n\0'):
        raise ValueError(f'memory: invalid runtime secret {name}')
    return value


def private_dir(path):
    if path.is_symlink():
        raise ValueError('memory: directory must not be a symlink')
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)


def write_private(path, value):
    if path.is_symlink():
        raise ValueError('memory: file must not be a symlink')
    temporary = path.with_name(path.name + '.tmp')
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(value)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def prepare(data=DATA, runtime=RUNTIME, secrets=Path('/run/secrets')):
    # Validate all credentials before changing persistent state. No generated shell.
    values = {name: secret(secrets / name, name) for name in SECRET_NAMES}
    for path in (data, runtime):
        private_dir(path)
        os.chown(path, 1000, 1000)
    for name, value in values.items():
        target = runtime / name
        write_private(target, value)
        os.chown(target, 1000, 1000)


def configure(home, data=DATA):
    identity_dir = Path(home).parent / '.agent-box'
    private_dir(identity_dir)
    identity = identity_dir / 'identity.json'
    if identity.is_symlink():
        raise ValueError('memory: identity must not be a symlink')
    if not identity.exists():
        write_private(identity, json.dumps({'schemaVersion': 1, 'boxId': str(uuid.uuid4()), 'name': 'helper'}))
    box_id = str(uuid.UUID(json.loads(identity.read_text())['boxId']))
    binding = data / 'box-id'
    if binding.is_symlink():
        raise ValueError('memory: volume binding must not be a symlink')
    if binding.exists() and binding.read_text() != box_id:
        raise ValueError('memory: volume belongs to a different box; restore its matching home volume')
    if not binding.exists():
        write_private(binding, box_id)
    root = Path(home) / 'hindsight'
    private_dir(root)
    write_private(root / 'config.json', json.dumps({
        'mode': 'local_external', 'api_url': 'http://127.0.0.1:8888', 'bank_id': 'box-' + box_id,
    }, indent=2) + '\n')
    config_path = Path(home) / 'config.yaml'
    if config_path.is_symlink():
        raise ValueError('memory: config must not be a symlink')
    config = json.loads(config_path.read_text())
    config['memory'] = {**config.get('memory', {}), 'provider': 'hindsight'}
    write_private(config_path, json.dumps(config, indent=2) + '\n')


def environment(source, runtime=RUNTIME):
    # Deliberately do not inherit HINDSIGHT_API_* overrides, credentials or dotenv.
    env = {'PATH': '/opt/hindsight/bin:/usr/local/bin:/usr/bin:/bin',
           'HOME': str(DATA), 'USER': 'hermes', 'LANG': 'C.UTF-8',
           'HINDSIGHT_API_HOST': '127.0.0.1', 'HINDSIGHT_API_PORT': '8888',
           'HINDSIGHT_API_DATABASE_URL': 'pg0://hindsight',
           'HINDSIGHT_API_EMBEDDINGS_PROVIDER': 'openai',
           'HINDSIGHT_API_RERANKER_PROVIDER': 'rrf',
           'HINDSIGHT_API_LOG_LEVEL': 'warning'}
    provider = source.get('MEMORY_LLM_PROVIDER', 'openai')
    if provider not in ('openai', 'anthropic'):
        raise ValueError('memory: MEMORY_LLM_PROVIDER must be openai or anthropic')
    env['HINDSIGHT_API_LLM_PROVIDER'] = provider
    env['HINDSIGHT_API_LLM_MODEL'] = source.get('MEMORY_LLM_MODEL', 'gpt-4o-mini' if provider == 'openai' else 'claude-sonnet-4-20250514')
    env['HINDSIGHT_API_LLM_API_KEY'] = secret(runtime / SECRET_NAMES[0], SECRET_NAMES[0])
    env['HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY'] = secret(runtime / SECRET_NAMES[1], SECRET_NAMES[1])
    for source_key, target in (
        ('MEMORY_LLM_BASE_URL', 'HINDSIGHT_API_LLM_BASE_URL'),
        ('MEMORY_EMBEDDINGS_BASE_URL', 'HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL'),
        ('MEMORY_EMBEDDINGS_MODEL', 'HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL'),
    ):
        if source.get(source_key):
            env[target] = source[source_key]
    return env


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'prepare':
            prepare()
        elif sys.argv[1] == 'configure':
            configure(os.environ['HERMES_HOME'])
        elif sys.argv[1] == 'run':
            env = environment(os.environ)
            os.chdir('/opt/hindsight')  # no dotenv from an agent-writable profile
            os.execve('/opt/hindsight/bin/hindsight-api', ['hindsight-api'], env)
        else:
            raise ValueError('memory: unknown lifecycle command')
    except ValueError as error:
        # Only our fixed diagnostics; UUID/JSON parsing errors can contain input.
        message = str(error)
        raise SystemExit(message if message.startswith('memory:') else 'memory: invalid persisted configuration (values redacted)')
    except (OSError, KeyError, TypeError):
        raise SystemExit('memory: lifecycle failed; check volume permissions and runtime secret files (values redacted)')
