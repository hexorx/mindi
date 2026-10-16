#!/usr/bin/env python3
"""Assemble THIRD-PARTY-NOTICES from pinned upstream texts; --check fails on any drift."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

PREAMBLE = """agent-box-hermes (backend-box) third-party notices

This file covers components that this image's recipes add without their own
license text. Other notices are shipped in place and are not repeated here:

- Debian packages: /usr/share/doc/<package>/copyright
- Hermes base image (nousresearch/hermes-agent): /opt/hermes/LICENSE and the
  license files under /opt/hermes
- Python packages: /opt/hindsight/lib/python3*/site-packages/*.dist-info
- Node packages: LICENSE files under /opt/mindi-backend/node_modules

Google Chrome and Claude Code (including the Claude ACP adapter) are not bundled.
They are downloaded at first start into /home/agent/.local/share/mindi-tools.
Their vendor terms and license files apply to those runtime downloads.

Statically linked binaries listed below may embed further third-party code
whose notices are not reproduced here.
"""


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def assemble(root=HERE):
    manifest = json.loads((root / 'sources.json').read_text())
    lic = manifest['license']
    if sha256((root / lic['file']).read_bytes()) != lic['sha256']:
        raise ValueError('LICENSE differs from sources.json')
    out = [PREAMBLE.encode()]
    for c in manifest['components']:
        text = (root / c['file']).read_bytes()
        if not text.strip():
            raise ValueError(f"empty license text: {c['name']}")
        if sha256(text) != c['sha256']:
            raise ValueError(f"license text changed: {c['name']}")
        out.append(f"\n{'=' * 78}\n{c['name']} {c['version']}\nLicense: {c['license']}\n"
                   f"Installed as: {c['installedAs']}\nSource: {c['source']}\n{'=' * 78}\n\n".encode())
        out.append(text if text.endswith(b'\n') else text + b'\n')
    return b''.join(out)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    expected = assemble()
    target = HERE / 'THIRD-PARTY-NOTICES'
    if args.check:
        if not target.is_file() or target.read_bytes() != expected:
            sys.exit('THIRD-PARTY-NOTICES is stale; run assemble.py')
        root_license = HERE.parents[5] / 'LICENSE'
        if root_license.is_file() and root_license.read_bytes() != (HERE / 'LICENSE').read_bytes():
            sys.exit('licenses/LICENSE differs from the repository LICENSE')
        print(f'notices OK: {sha256(expected)}')
        return
    target.write_bytes(expected)
    print(f'wrote {target.name}: {len(expected)} bytes {sha256(expected)}')


if __name__ == '__main__':
    main()
