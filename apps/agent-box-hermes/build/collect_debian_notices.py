#!/usr/bin/env python3
"""Retain the installed Debian copyright bytes for replacement dependencies."""
import gzip
import hashlib
import json
from pathlib import Path
import subprocess


def collect(packages, root, destination, query):
    destination.mkdir(parents=True, exist_ok=True)
    rows = []
    for package in packages:
        notice = root / 'usr/share/doc' / package / 'copyright'
        if notice.is_file():
            data = notice.read_bytes()
        elif notice.with_suffix('.gz').is_file():
            notice = notice.with_suffix('.gz')
            data = gzip.decompress(notice.read_bytes())
        else:
            raise ValueError(f'{package}: installed Debian copyright missing')
        identity = query(package).strip().split('\t')
        if len(identity) != 4:
            raise ValueError(f'{package}: unexpected dpkg identity')
        filename = package + '.copyright'
        (destination / filename).write_bytes(data)
        rows.append({'package': package, 'version': identity[0], 'architecture': identity[1],
                     'source_package': identity[2], 'source_version': identity[3],
                     'original_path': '/' + str(notice.relative_to(root)),
                     'file': filename, 'sha256': hashlib.sha256(data).hexdigest(),
                     'status': 'installed Debian copyright; not an independent upstream source audit'})
    (destination / 'manifest.json').write_text(json.dumps(rows, indent=2) + '\n')
    return rows


def main():
    packages = Path(__file__).with_name('payload-debian-packages.txt').read_text().split()
    def query(package):
        return subprocess.check_output([
            'dpkg-query', '-W', '-f',
            '${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n',
            package], text=True)
    collect(packages, Path('/'),
            Path('/usr/share/doc/agent-box-hermes/third-party/debian-replacements'), query)


if __name__ == '__main__':
    main()
