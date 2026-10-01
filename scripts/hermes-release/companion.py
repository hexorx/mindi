"""Bounded, nonexecuting verification of HEX-215 corresponding-source bytes."""
import hashlib
import json
from pathlib import PurePosixPath
import tarfile

from gate import MAX_BYTES, SHA, digest_file, match, no_duplicates, read_json, require

REPO = 'hexorx/mindi'
META_LIMIT = 16 * 1024**2
PART_LIMIT = 1_900_000_000
META = {'README.md', 'manifest.json', 'SOURCES.tsv', 'COMPONENTS.tsv', 'UNSOURCED.tsv'}


def pointer(record):
    return 'https://github.com/' + REPO + '/releases/tag/hermes-source-' + record['source_commit']


def prefix(record):
    return 'source-companion-' + record['manifest_digest'][7:19]


def inventory(record):
    c = record['source_companion']
    require(set(c) == {'repository', 'release_id', 'url', 'assets'}, 'unexpected companion inventory fields')
    require(c['repository'] == REPO and c['url'] == pointer(record), 'companion release pointer mismatch')
    require(type(c['release_id']) is int and c['release_id'] > 0, 'invalid companion release id')
    assets = c['assets']
    require(isinstance(assets, list) and 5 <= len(assets) <= 68, 'invalid companion asset count')
    names = [prefix(record) + '.PARTS.json', prefix(record) + '.SHA256SUMS',
             prefix(record) + '.manifest.json', prefix(record) + '.README.md']
    names += [prefix(record) + '.tar.part%02d' % n for n in range(len(assets) - 4)]
    ids = [a['id'] for a in record['assets']]
    for n, asset in enumerate(assets):
        require(set(asset) == {'id', 'name', 'size', 'sha256'}, 'unexpected companion asset fields')
        require(type(asset['id']) is int and asset['id'] > 0, 'invalid companion asset id')
        require(asset['name'] == names[n], 'unexpected or unordered companion asset')
        require(type(asset['size']) is int and 0 < asset['size'] <= (META_LIMIT if n < 4 else PART_LIMIT), 'invalid companion asset size')
        require(match(SHA, asset['sha256']), 'invalid companion asset hash')
        ids.append(asset['id'])
    require(len(set(ids)) == len(ids), 'duplicate transport asset id')
    require(sum(a['size'] for a in assets) <= MAX_BYTES, 'companion too large')
    return assets


def safe_path(name):
    require(isinstance(name, str) and name and not name.startswith('/') and '\\' not in name
            and all(p not in {'', '.', '..'} for p in name.split('/'))
            and str(PurePosixPath(name)) == name, 'unsafe companion path')
    return name


def checksums(raw):
    result = {}
    for line in raw.decode('utf-8').splitlines():
        digest, sep, name = line.partition('  ')
        require(sep and match(SHA, digest), 'malformed companion checksums')
        safe_path(name)
        require(name not in result, 'duplicate companion checksum')
        result[name] = digest
    require(result, 'empty companion checksums')
    return result


def verify(record, directory, config_digest):
    assets = inventory(record)
    require({p.name for p in directory.iterdir()} == {a['name'] for a in assets}, 'missing/extra companion files')
    for a in assets:
        path = directory / a['name']
        require(path.is_file() and not path.is_symlink() and path.stat().st_size == a['size']
                and digest_file(path) == a['sha256'], 'companion asset size/hash mismatch')
    info = read_json(directory / assets[0]['name'])
    require(set(info) == {'schema', 'tar_name', 'tar_size', 'tar_sha256', 'part_limit', 'parts', 'manifest_sha256', 'members_sha256sums_sha256'}, 'unexpected PARTS fields')
    parts = [{k: a[k] for k in ('name', 'size', 'sha256')} for a in assets[4:]]
    require(info['schema'] == 'hexorx.source-companion-parts/1' and info['tar_name'] == prefix(record) + '.tar'
            and type(info['part_limit']) is int and info['part_limit'] == PART_LIMIT and info['parts'] == parts, 'PARTS inventory mismatch')
    require(all(isinstance(p, dict) and type(p.get('size')) is int for p in info['parts']), 'invalid PARTS sizes')
    require(all(p['size'] == PART_LIMIT for p in parts[:-1]), 'partial intermediate companion part')
    require(type(info['tar_size']) is int and info['tar_size'] == sum(p['size'] for p in parts), 'companion tar size mismatch')
    require(checksums((directory / assets[1]['name']).read_bytes()) == {p['name']: p['sha256'] for p in parts}, 'outer companion checksums mismatch')
    # Concatenate via a bounded reader, never into the image ZIP or a second tar.
    class PartsReader:
        def __init__(self):
            self.paths = iter(parts)
            self.stream = None
            self.hash = hashlib.sha256()
            self.total = 0
        def read(self, size):
            require(0 < size <= META_LIMIT, 'unbounded companion read')
            result = bytearray()
            while len(result) < size:
                if self.stream is None:
                    part = next(self.paths, None)
                    if part is None:
                        break
                    self.stream = (directory / part['name']).open('rb')
                chunk = self.stream.read(size - len(result))
                if not chunk:
                    self.stream.close()
                    self.stream = None
                    continue
                result.extend(chunk)
            self.hash.update(result)
            self.total += len(result)
            return bytes(result)
        def close(self):
            if self.stream:
                self.stream.close()
    class BoundedTarInfo(tarfile.TarInfo):
        def _proc_member(self, archive):
            require(self.type in {tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.XHDTYPE}, 'companion special headers forbidden')
            if self.type == tarfile.XHDTYPE:
                require(0 <= self.size <= META_LIMIT, 'companion extended header too large')
            return super()._proc_member(archive)

    reader = PartsReader()
    observed, metadata = {}, {}
    try:
        with tarfile.open(fileobj=reader, mode='r|', tarinfo=BoundedTarInfo) as archive:
            for member in archive:
                require(member.isfile() and set(member.pax_headers) <= {'path'}, 'companion special members forbidden')
                root, sep, rel = member.name.partition('/')
                require(sep and root == prefix(record), 'companion archive root mismatch')
                safe_path(rel)
                require(rel not in observed and len(observed) < 100000, 'duplicate/excess companion members')
                require(0 <= member.size <= MAX_BYTES, 'invalid companion member size')
                stream = archive.extractfile(member)
                h, size, chunks = hashlib.sha256(), 0, []
                if rel in META | {'SHA256SUMS'}:
                    require(member.size <= META_LIMIT, 'companion metadata too large')
                while chunk := stream.read(1024**2):
                    h.update(chunk)
                    size += len(chunk)
                    if rel in META | {'SHA256SUMS'}:
                        chunks.append(chunk)
                require(size == member.size, 'partial companion member')
                observed[rel] = {'sha256': h.hexdigest(), 'size': size}
                if rel in META | {'SHA256SUMS'}:
                    metadata[rel] = b''.join(chunks)
            # tarfile stops at the end marker. Drain and hash all padding bytes.
            while chunk := archive.fileobj.read(1024**2):
                require(not any(chunk), 'unexpected trailing companion bytes')
        require(reader.total == info['tar_size'] and reader.hash.hexdigest() == info['tar_sha256'], 'whole companion tar mismatch')
    finally:
        reader.close()
    require(set(metadata) == META | {'SHA256SUMS'}, 'missing companion metadata')
    require(observed['manifest.json']['sha256'] == info['manifest_sha256']
            and observed['SHA256SUMS']['sha256'] == info['members_sha256sums_sha256'], 'companion metadata hash mismatch')
    for asset, member in zip(assets[2:4], ('manifest.json', 'README.md')):
        require((directory / asset['name']).read_bytes() == metadata[member],
                'external/internal companion sidecar mismatch: ' + member)
    sums = checksums(metadata['SHA256SUMS'])
    require(sums == {n: v['sha256'] for n, v in observed.items() if n != 'SHA256SUMS'}, 'internal companion checksums mismatch')
    manifest = json.loads(metadata['manifest.json'], object_pairs_hook=no_duplicates, parse_constant=lambda _: require(False, 'non-finite companion JSON'))
    identity = {'index': record['manifest_digest'], 'manifest': record['platform_manifest_digest'],
                'config': config_digest, 'built_source': record['source_commit']}
    require(manifest['schema'] == 'hexorx.source-companion/1' and manifest['mode'] == 'full'
            and manifest['delivered'] is True and manifest['unsourced'] == []
            and not manifest['inventory'].get('identity_errors'), 'companion source delivery incomplete')
    require(all(manifest['image'].get(k) == v for k, v in identity.items()), 'companion image identity mismatch')
    readme = metadata['README.md'].decode('utf-8').splitlines()
    for line in (f"Image: `{identity['index']}` (OCI index digest)", f"Platform manifest: `{identity['manifest']}`",
                 f"Config digest: `{identity['config']}`", f"Built source: `{identity['built_source']}`"):
        label = line.split(':', 1)[0] + ':'
        require([x for x in readme if x.startswith(label)] == [line], 'companion README identity mismatch')
    expected = set(META) | {'SHA256SUMS'}
    require(isinstance(manifest['sources'], list) and manifest['sources'], 'companion sources missing')
    for source in manifest['sources']:
        require(isinstance(source['files'], list) and source['files'], 'source files missing')
        for f in source['files']:
            name = safe_path(source['dir'] + '/' + f['name'])
            require(name not in expected, 'duplicate source payload')
            expected.add(name)
            require(type(f['size']) is int and f['size'] > 0 and match(SHA, f['sha256'])
                    and observed.get(name) == {'size': f['size'], 'sha256': f['sha256']}, 'manifest payload mismatch')
    require(expected == set(observed), 'unexpected/missing source payload')
    return {'url': pointer(record), 'tar_sha256': info['tar_sha256'], 'assets': len(assets)}
