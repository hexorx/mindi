"""Synthetic HEX-215 archive; never evidence for a real image."""
import hashlib
import io
import json
import tarfile

import companion


def sha(data):
    return hashlib.sha256(data).hexdigest()


def encode(data):
    return json.dumps(data).encode()


def make_companion(record, directory, config, mutate=None, extra=None):
    directory.mkdir(exist_ok=True)
    identity = {'index': record['manifest_digest'], 'manifest': record['platform_manifest_digest'],
                'config': config, 'built_source': record['source_commit']}
    manifest = {'schema': 'hexorx.source-companion/1', 'mode': 'full', 'delivered': True,
                'unsourced': [], 'inventory': {}, 'image': identity,
                'sources': [{'dir': 'sources/example', 'files': [{'name': 'source.txt', 'size': 7, 'sha256': sha(b'source\n')}]}]}
    files = {'README.md': (f"Image: `{identity['index']}` (OCI index digest)\nPlatform manifest: `{identity['manifest']}`\n"
                          f"Config digest: `{identity['config']}`\nBuilt source: `{identity['built_source']}`\n").encode(),
             'SOURCES.tsv': b'fixture\n', 'COMPONENTS.tsv': b'fixture\n', 'UNSOURCED.tsv': b'fixture\n',
             'sources/example/source.txt': b'source\n'}
    if mutate:
        mutate(manifest, files)
    files['manifest.json'] = encode(manifest)
    files['SHA256SUMS'] = ''.join(sha(data) + '  ' + name + '\n' for name, data in sorted(files.items())).encode()
    prefix = companion.prefix(record)
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w', format=tarfile.PAX_FORMAT) as archive:
        for name, data in sorted(files.items()):
            member = tarfile.TarInfo(prefix + '/' + name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
        if extra:
            archive.addfile(extra)
    raw = out.getvalue()
    part = {'name': prefix + '.tar.part00', 'size': len(raw), 'sha256': sha(raw)}
    parts = {'schema': 'hexorx.source-companion-parts/1', 'tar_name': prefix + '.tar', 'tar_size': len(raw),
             'tar_sha256': sha(raw), 'part_limit': companion.PART_LIMIT, 'parts': [part],
             'manifest_sha256': sha(files['manifest.json']), 'members_sha256sums_sha256': sha(files['SHA256SUMS'])}
    assets = []
    for n, (name, data) in enumerate([(prefix + '.PARTS.json', encode(parts)),
                                     (prefix + '.SHA256SUMS', (part['sha256'] + '  ' + part['name'] + '\n').encode()),
                                     (prefix + '.manifest.json', files['manifest.json']),
                                     (prefix + '.README.md', files['README.md']),
                                     (part['name'], raw)]):
        (directory / name).write_bytes(data)
        assets.append({'id': 100 + n, 'name': name, 'size': len(data), 'sha256': sha(data)})
    record['source_companion'] = {'repository': companion.REPO, 'release_id': 99, 'url': companion.pointer(record), 'assets': assets}
    return directory
