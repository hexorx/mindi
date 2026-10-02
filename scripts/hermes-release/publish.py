#!/usr/bin/env python3
"""Publish one scanned, smoke-tested image under a non-overwritable SHA tag."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

PACKAGE = 'users/hexorx/packages/container/agent-box-hermes'
IMAGE = 'ghcr.io/hexorx/agent-box-hermes'


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs)


def package_state(allow_missing=False):
    result = subprocess.run(['gh', 'api', PACKAGE], capture_output=True)
    if result.returncode:
        # GHCR creates new packages private. Do not swallow 401/403/transport errors.
        if allow_missing and b'(HTTP 404)' in result.stderr:
            return None
        raise ValueError('Private package metadata unavailable')
    value = json.loads(result.stdout)
    if value.get('visibility') != 'private':
        raise ValueError('Refusing a non-private package')
    return value


def preflight(sha):
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('Expected full source SHA')
    state = package_state(allow_missing=True)
    if state is None:
        return 'sha-' + sha
    pages = json.loads(run(['gh', 'api', '--paginate', '--slurp', PACKAGE + '/versions?per_page=100']).stdout)
    tag = 'sha-' + sha
    if any(tag in row.get('metadata', {}).get('container', {}).get('tags', [])
           for page in pages for row in page):
        raise ValueError('Immutable source tag already exists; refusing overwrite')
    return tag


def publish(sha, archive, receipt):
    tag = preflight(sha)
    digest = 'sha256:' + hashlib.sha256(run(['skopeo', 'inspect', '--raw', 'oci-archive:' + str(archive)]).stdout).hexdigest()
    receipt.write_text(json.dumps({'source': sha, 'tag': IMAGE + ':' + tag,
                                   'expected_image': IMAGE + '@' + digest, 'status': 'prepared'}) + '\n')
    # Auth comes from a private runtime auth file, never argv or image content.
    run(['skopeo', 'copy', '--preserve-digests', '--authfile', os.environ['REGISTRY_AUTH_FILE'],
         'oci-archive:' + str(archive), 'docker://' + IMAGE + ':' + tag])
    actual = 'sha256:' + hashlib.sha256(run(['skopeo', 'inspect', '--raw', '--authfile', os.environ['REGISTRY_AUTH_FILE'],
                                           'docker://' + IMAGE + ':' + tag]).stdout).hexdigest()
    if actual != digest:
        raise ValueError('Published digest mismatch')
    package_state()
    receipt.write_text(json.dumps({'source': sha, 'tag': IMAGE + ':' + tag,
                                   'image': IMAGE + '@' + digest, 'visibility': 'private'}, indent=2) + '\n')


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'preflight':
            preflight(os.environ['GITHUB_SHA'])
        else:
            publish(os.environ['GITHUB_SHA'], Path(sys.argv[2]), Path(sys.argv[3]))
    except Exception:
        raise SystemExit('Publication refused or incomplete; preserve artifacts and inspect package metadata (details redacted)') from None
