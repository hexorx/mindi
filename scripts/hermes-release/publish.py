#!/usr/bin/env python3
"""Publish one scanned, smoke-tested image under a non-overwritable SHA tag."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from urllib.parse import quote, urljoin
from urllib.request import Request, urlopen

import license_gate

REGISTRY = 'https://ghcr.io/v2/hexorx/agent-box-hermes/'
IMAGE = 'ghcr.io/hexorx/agent-box-hermes'


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs)


def anonymous_token():
    # No account credentials: GHCR issues pull tokens for public repositories.
    with urlopen('https://ghcr.io/token?service=ghcr.io&scope=repository:hexorx/agent-box-hermes:pull', timeout=30) as response:
        return json.load(response)['token']


def registry_get(url, token):
    request = Request(url, headers={
        'Authorization': 'Bearer ' + token,
        'Accept': ', '.join(('application/vnd.oci.image.manifest.v1+json',
                            'application/vnd.oci.image.index.v1+json',
                            'application/vnd.docker.distribution.manifest.v2+json',
                            'application/vnd.docker.distribution.manifest.list.v2+json')),
    })
    with urlopen(request, timeout=30) as response:
        return response.read(), response.headers.get('Link')


def public_manifest(reference, token=None):
    raw, _ = registry_get(REGISTRY + 'manifests/' + quote(reference, safe=':'),
                          token if token is not None else anonymous_token())
    if json.loads(raw).get('schemaVersion') != 2:
        raise ValueError('Invalid public manifest')
    return raw


def preflight(sha):
    if not re.fullmatch('[0-9a-f]{40}', sha):
        raise ValueError('Expected full source SHA')
    token = anonymous_token()
    tag = 'sha-' + sha
    url = REGISTRY + 'tags/list?n=100'
    seen = set()
    public_tag = None
    while url:
        if url in seen or not url.startswith(REGISTRY + 'tags/list?'):
            raise ValueError('Invalid registry pagination')
        seen.add(url)
        raw, link = registry_get(url, token)
        tags = json.loads(raw).get('tags')
        if not isinstance(tags, list) or any(not isinstance(t, str) for t in tags):
            raise ValueError('Invalid registry tags')
        if tag in tags:
            raise ValueError('Immutable source tag already exists; refusing overwrite')
        if tags:
            public_tag = tags[0]
        if link:
            match = re.fullmatch(r'<([^>]+)>;\s*rel="next"', link)
            if not match:
                raise ValueError('Invalid registry pagination')
            url = urljoin(url, match[1])
        else:
            url = None
    if public_tag is None:
        raise ValueError('No existing public image to verify')
    public_manifest(public_tag, token)
    return tag


def publish(sha, archive, receipt):
    # Recheck the exact archive here too: direct CLI use cannot skip this gate.
    licensing = license_gate.check(archive, sha, receipt.with_name("license-summary.json"))
    tag = preflight(sha)
    digest = 'sha256:' + hashlib.sha256(run(['skopeo', 'inspect', '--raw', 'oci-archive:' + str(archive)]).stdout).hexdigest()
    if digest != licensing['manifest_digest']:
        raise ValueError('License-checked manifest differs from publication manifest')
    receipt.write_text(json.dumps({'source': sha, 'workflow_sha': sha, 'built_source_sha': sha, 'tag': IMAGE + ':' + tag,
                                   'expected_image': IMAGE + '@' + digest, 'status': 'prepared'}) + '\n')
    # Auth comes from a private runtime auth file, never argv or image content.
    run(['skopeo', 'copy', '--preserve-digests', '--authfile', os.environ['REGISTRY_AUTH_FILE'],
         'oci-archive:' + str(archive), 'docker://' + IMAGE + ':' + tag])
    actual = 'sha256:' + hashlib.sha256(run(['skopeo', 'inspect', '--raw', '--authfile', os.environ['REGISTRY_AUTH_FILE'],
                                           'docker://' + IMAGE + ':' + tag]).stdout).hexdigest()
    if actual != digest:
        raise ValueError('Published digest mismatch')
    if hashlib.sha256(public_manifest(tag)).hexdigest() != digest.removeprefix('sha256:'):
        raise ValueError('Public digest mismatch')
    receipt.write_text(json.dumps({'source': sha, 'workflow_sha': sha, 'built_source_sha': sha, 'tag': IMAGE + ':' + tag,
                                   'image': IMAGE + '@' + digest, 'visibility': 'public'}, indent=2) + '\n')


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'preflight':
            preflight(os.environ['GITHUB_SHA'])
        else:
            publish(os.environ['GITHUB_SHA'], Path(sys.argv[2]), Path(sys.argv[3]))
    except Exception:
        raise SystemExit('Publication refused or incomplete; preserve artifacts and inspect registry evidence (details redacted)') from None
