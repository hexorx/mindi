"""Convert ordered pip reports to an exact wheel lock, checked against pip inspect."""
import argparse
import json
from pathlib import Path
import re
from urllib.parse import urlsplit


def canonical(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def render(reports, inventory):
    resolved = {}
    for report in reports:
        for item in report['install']:
            name = canonical(item['metadata']['name'])
            version = item['metadata']['version']
            download = item['download_info']
            url = download['url']
            parts = urlsplit(url)
            digest = download.get('archive_info', {}).get('hashes', {}).get('sha256', '')
            if (parts.scheme != 'https' or parts.hostname not in
                    {'files.pythonhosted.org', 'download.pytorch.org', 'download-r2.pytorch.org'} or
                    parts.username or parts.password or parts.query or parts.fragment or
                    not parts.path.endswith('.whl') or
                    not re.fullmatch('[0-9a-f]{64}', digest)):
                raise ValueError(f'Unverified wheel: {name}')
            if not re.fullmatch('[a-z0-9][a-z0-9-]*', name) or any(c.isspace() for c in url):
                raise ValueError(f'Invalid requirement: {name}')
            resolved[name] = (version, url, digest)
    # pip is seeded by ensurepip in the digest-pinned base; it is not a resolver input.
    installed = {canonical(x['metadata']['name']): x['metadata']['version']
                 for x in inventory['installed'] if canonical(x['metadata']['name']) != 'pip'}
    if {k: v[0] for k, v in resolved.items()} != installed:
        raise ValueError('Reports do not match the complete installed package inventory')
    lines = ['# linux/amd64 CPython 3.13; generated from HEX-184 ordered pip reports.',
             '# Direct wheel URLs and hashes; no dependency resolution or index fallback.',
             '# pip is supplied by ensurepip from the digest-pinned Hermes base.']
    for name, (version, url, digest) in sorted(resolved.items()):
        lines.extend([f'# {name}=={version}', f'{name} @ {url} --hash=sha256:{digest}'])
    return '\n'.join(lines) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inventory', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('reports', type=Path, nargs='+')
    args = parser.parse_args()
    args.output.write_text(render([json.loads(p.read_text()) for p in args.reports],
                                  json.loads(args.inventory.read_text())))


if __name__ == '__main__':
    main()
