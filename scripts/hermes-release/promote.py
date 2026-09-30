#!/usr/bin/env python3
"""Trusted-main workflow entry point. No build or candidate code execution."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

from gate import COMMIT, DESTINATION, SHA, digest_file, match, read_json, require, unpack_bundle, validate_record, verify_candidate

REPO = 'hexorx/mindi'


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def github(path):
    return json.loads(run(['gh', 'api', 'repos/' + REPO + '/' + path], capture_output=True).stdout)


def trusted_context():
    require(os.environ.get('GITHUB_REPOSITORY') == REPO, 'untrusted repository')
    require(os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'manual dispatch required')
    require(os.environ.get('GITHUB_REF') == 'refs/heads/main', 'trusted main ref required')
    sha = os.environ.get('GITHUB_SHA', '')
    require(match(COMMIT, sha), 'invalid workflow commit')
    require(github('git/ref/heads/main')['object']['sha'] == sha, 'stale workflow main; redispatch')
    require(run(['git', 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip() == sha, 'checkout mismatch')


def check_source(record):
    for commit in {record['source_commit'], record['accepted_commit']}:
        run(['git', 'merge-base', '--is-ancestor', commit, 'HEAD'], capture_output=True)
    # These checks come from the repository CI workflow, not candidate report assertions.
    runs = github('commits/' + record['accepted_commit'] + '/check-runs?per_page=100')['check_runs']
    for name in ('check', 'container'):
        candidates = [r for r in runs if r['name'] == name and r['app']['slug'] == 'github-actions' and r['head_sha'] == record['accepted_commit']]
        require(candidates, 'required exact-head CI check missing: ' + name)
        latest = max(candidates, key=lambda r: r['id'])
        require(latest['status'] == 'completed' and latest['conclusion'] == 'success', 'exact-head CI failed: ' + name)


def download(record, work):
    bundle = work / 'candidate.zip'
    # Parts allow large OCI exports while staying below GitHub release asset limits.
    total = sum(a['size'] for a in record['assets'])
    require(shutil.disk_usage(work).free > total * 5 + 1024**3, 'insufficient staging disk')
    with bundle.open('xb') as target:
        for asset in record['assets']:
            meta = github('releases/assets/' + str(asset['id']))
            require(meta['id'] == asset['id'] and meta['state'] == 'uploaded' and meta['size'] == asset['size'], 'asset metadata mismatch')
            part = work / ('part-' + str(asset['id']))
            with part.open('xb') as output:
                run(['gh', 'api', 'repos/' + REPO + '/releases/assets/' + str(asset['id']), '-H', 'Accept: application/octet-stream'], stdout=output)
            require(part.stat().st_size == asset['size'] and digest_file(part) == asset['sha256'], 'asset digest/size mismatch')
            with part.open('rb') as source:
                shutil.copyfileobj(source, target, 1024**2)
    return bundle


def registry_token():
    credential = os.environ['GHCR_TOKEN']
    actor = os.environ['GITHUB_ACTOR']
    request = urllib.request.Request('https://ghcr.io/token?service=ghcr.io&scope=repository:hexorx/agent-box-hermes:pull,push',
                                     headers={'Authorization': 'Basic ' + base64.b64encode((actor + ':' + credential).encode()).decode()})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)['token']


def assert_tag_absent(tag, token, opener=urllib.request.urlopen):
    request = urllib.request.Request('https://ghcr.io/v2/hexorx/agent-box-hermes/manifests/' + tag,
                                    headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'})
    try:
        with opener(request, timeout=60):
            raise ValueError('immutable tag already exists: ' + tag)
    except urllib.error.HTTPError as error:
        # A timeout, 401/403, 429, 5xx, or generic proxy 404 is NOT absence.
        require(error.code == 404, 'cannot establish tag absence')
        payload = json.load(error)
        errors = payload.get('errors')
        # Distribution also uses MANIFEST_UNKNOWN for media negotiation errors.
        # Accept only canonical absence responses; unexpected wording/detail fails closed.
        messages = {'MANIFEST_UNKNOWN': 'manifest unknown', 'NAME_UNKNOWN': 'repository name not known to registry'}
        require(isinstance(errors, list) and errors and all(
            isinstance(e, dict) and e.get('code') in messages
            and e.get('message') == messages[e['code']]
            and e.get('detail') in (None, tag, {'Tag': tag})
            for e in errors), 'unverified registry absence')


def publish(record, directory, work):
    result = verify_candidate(record, directory)  # Immediately before credentials/push.
    token = registry_token()
    for tag in result['tags']:
        assert_tag_absent(tag, token)  # Check BOTH before the first write.
    auth = work / 'auth.json'
    fd = os.open(auth, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as output:
        json.dump({'auths': {'ghcr.io': {'auth': base64.b64encode((os.environ['GITHUB_ACTOR'] + ':' + os.environ['GHCR_TOKEN']).encode()).decode()}}}, output)
    # No subprocess receives the token in argv or environment; only the 0600 authfile.
    clean_env = {k: v for k, v in os.environ.items() if k not in {'GHCR_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'}}
    receipt = {**result, 'published_tags': [], 'attempted_tags': [], 'anonymous_pull': 'not-run', 'ticket_record': record['ticket_record']}
    def save():
        (work / 'receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    save()
    try:
        for tag in result['tags']:
            assert_tag_absent(tag, token)
            digest_path = work / (tag + '.digest')
            receipt['attempted_tags'].append(tag)
            save()
            run(['skopeo', 'copy', '--all', '--preserve-digests', '--authfile', str(auth), '--digestfile', str(digest_path),
                 'oci-archive:' + str(directory / 'image.oci.tar'), 'docker://' + DESTINATION + ':' + tag], env=clean_env)
            require(digest_path.read_text().strip() == record['manifest_digest'], 'published manifest digest mismatch')
            receipt['published_tags'].append(tag)
            save()
        # Fetch all blobs anonymously by immutable digest, not just a HEAD/config lookup.
        run(['skopeo', 'copy', '--all', '--src-no-creds', '--preserve-digests', '--digestfile', str(work / 'anonymous.digest'),
             'docker://' + DESTINATION + '@' + record['manifest_digest'], 'oci:' + str(work / 'anonymous')], env=clean_env)
        require((work / 'anonymous.digest').read_text().strip() == record['manifest_digest'], 'anonymous pull digest mismatch')
        for tag in result['tags']:
            raw = run(['skopeo', 'inspect', '--no-creds', '--raw', 'docker://' + DESTINATION + ':' + tag], capture_output=True, env=clean_env).stdout
            require('sha256:' + hashlib.sha256(raw).hexdigest() == record['manifest_digest'], 'anonymous tag manifest mismatch')
        receipt['anonymous_pull'] = 'pass'
        save()
    finally:
        # Clear only this run's generated auth file, never registry data or user files.
        auth.write_text('{}\n')
    return receipt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['qualify', 'promote'])
    args = parser.parse_args()
    trusted_context()
    record_id = os.environ.get('RECORD_ID', '')
    expected = os.environ.get('RECORD_SHA256', '')
    require(match(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?', record_id), 'invalid record id')
    require(match(SHA, expected), 'record digest required')
    record_path = Path('releases/hermes') / (record_id + '.json')
    require(not record_path.is_symlink() and digest_file(record_path) == expected, 'reviewed record digest mismatch')
    record = read_json(record_path)
    validate_record(record)
    require(record['version'] == record_id, 'record/version mismatch')
    check_source(record)
    work = Path(os.environ['RUNNER_TEMP']) / ('hermes-' + args.mode)
    work.mkdir(mode=0o700)
    bundle = download(record, work)
    directory = work / 'candidate'
    result = unpack_bundle(record, bundle, directory)
    if args.mode == 'promote':
        require(os.environ.get('PROMOTE') == 'true', 'explicit promotion confirmation required')
        trusted_context()  # main must not have changed during qualification/download.
        check_source(record)
        result = publish(record, directory, work)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write('## Hermes ' + args.mode + '\n\n```json\n' + json.dumps(result, indent=2) + '\n```\n')
    print(json.dumps(result))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError) as error:
        # Never render HTTP payloads, subprocess output or credentials.
        print('Release gate refused: ' + (str(error) if isinstance(error, ValueError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)
