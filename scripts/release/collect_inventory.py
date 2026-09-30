#!/usr/bin/env python3
"""Read installed package metadata and notice bytes; emit evidence, not an SBOM.

Run separately with every image Python interpreter (including /opt/hindsight).
Does not install packages, import their code, access the network or run services.
"""
import argparse
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import subprocess
import sys


def notice(path, root):
    path = Path(path).resolve()
    root = Path(root).resolve()
    if not path.is_relative_to(root):
        raise ValueError(f'notice escapes inventory root: {path}')
    raw = path.read_bytes()
    return {'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest(),
            'content_base64': base64.b64encode(raw).decode('ascii')}


def python_inventory(distributions=None):
    result = []
    if distributions is None:
        distributions = importlib.metadata.distributions()
    for dist in distributions:
        texts = []
        for file in dist.files or []:
            # Restrict collection to package metadata, never arbitrary app files.
            if not any(p.endswith(('.dist-info', '.egg-info')) for p in file.parts):
                continue
            if (file.name.lower().startswith(('license', 'copying', 'notice', 'authors'))
                    or any(p.lower() in ('licenses', 'license') for p in file.parts)):
                texts.append(notice(dist.locate_file(file), dist.locate_file('')))
        result.append({'name': dist.metadata['Name'], 'version': dist.version,
                       'requires_dist': dist.metadata.get_all('Requires-Dist') or [],
                       'license_expression': dist.metadata.get('License-Expression'),
                       'license_metadata': dist.metadata.get('License'),
                       'notices': sorted(texts, key=lambda t: t['path']),
                       'notice_status': 'collected_unreviewed' if texts else 'missing'})
    return sorted(result, key=lambda d: (d['name'].lower(), d['version']))


def debian_inventory():
    output = subprocess.check_output([
        'dpkg-query', '-W', '-f=${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\t${db:Status-Status}\n'
    ], text=True)
    result = []
    for line in output.splitlines():
        package, version, arch, source, source_version, status = line.split('\t')
        if status != 'installed':
            continue
        path = Path('/usr/share/doc') / package.split(':')[0] / 'copyright'
        texts = [notice(path, '/usr/share/doc')] if path.is_file() else []
        result.append({'name': package, 'version': version, 'architecture': arch,
                       'source_package': source, 'source_version': source_version,
                       'notices': texts,
                       'notice_status': 'collected_unreviewed' if texts else 'missing'})
    return sorted(result, key=lambda d: d['name'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--include-debian', action='store_true')
    args = parser.parse_args()
    evidence = {'schema_version': 1, 'complete': False,
                'kind': 'installed-package-evidence',
                'python': {'executable': sys.executable, 'version': platform.python_version(),
                           'packages': python_inventory()},
                'unresolved': ['artifact hashes and immutable download sources',
                               'non-package artifacts: Hermes, s6, cua-driver, pg0/PostgreSQL, Tailscale/Go',
                               'license text completeness and corresponding-source obligations',
                               'final image SBOM reconciliation']}
    if args.include_debian:
        evidence['debian'] = debian_inventory()
        # Debian copyright files often reference these full license texts.
        evidence['debian_common_licenses'] = [
            notice(path, '/usr/share/common-licenses')
            for path in sorted(Path('/usr/share/common-licenses').iterdir())
            if path.is_file()
        ]
    json.dump(evidence, sys.stdout, sort_keys=True, indent=2)
    print()


if __name__ == '__main__':
    main()
