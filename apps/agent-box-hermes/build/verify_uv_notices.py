#!/usr/bin/env python3
"""Verify shipped uv notices against cargo-auditable sections, without executing uv."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import zlib

DECLARED = 'declared license only; upstream notice text not found'
SUPPLEMENTAL = 'supplemental SPDX license text, not upstream notice text'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def dep_section(binary):
    data = Path(binary).read_bytes()
    if data[:6] != b'\x7fELF\x02\x01':
        raise ValueError('expected ELF64 little-endian uv binary')
    offset = struct.unpack_from('<Q', data, 40)[0]
    size, count, names_index = struct.unpack_from('<HHH', data, 58)
    if size != 64 or not 0 < names_index < count:
        raise ValueError('invalid ELF section table')
    sections = [struct.unpack_from('<IIQQQQIIQQ', data, offset + i * size) for i in range(count)]
    names = sections[names_index]
    strings = data[names[4]:names[4] + names[5]]
    matches = [s for s in sections if strings[s[0]:].split(b'\0', 1)[0] == b'.dep-v0']
    if len(matches) != 1:
        raise ValueError('expected exactly one .dep-v0 section')
    section = matches[0]
    return zlib.decompress(data[section[4]:section[4] + section[5]])


def render(root, manifest, dispositions):
    """Assemble bytes directly: upstream text is never decoded or normalized."""
    out = [b'Third-party crates in uv/uvx 0.12.21.\n',
           b'Upstream files are preserved byte-for-byte under crates/.\n',
           (SUPPLEMENTAL + ': spdx/.\n\n').encode()]
    for r in manifest['records']:
        key = (r['name'], r['version'])
        out.append(f"{'=' * 78}\n{r['name']} {r['version']}  Declared license: {r['license']}\n".encode())
        if r['files']:
            for f in r['files']:
                out.extend([f"--- upstream file: {f['path']}\n".encode(),
                            (root / 'crates' / f"{r['name']}-{r['version']}" / f['path']).read_bytes(), b'\n'])
        else:
            d = dispositions[key]
            out.append((DECLARED + '\n').encode())
            out.append(f"Distribution license: {d['distribution_license']}\n".encode())
            meta = r['declared_only']
            out.append(f"Cargo.toml authors (not copyright holders): {json.dumps(meta['cargo_toml_authors_metadata_only'], ensure_ascii=False)}\n".encode())
            out.append(f"Cargo.toml repository: {meta['repository']}\n".encode())
            for path in meta['supplemental_spdx_texts']:
                out.append(f'{SUPPLEMENTAL}: {path}\n'.encode())
        out.append(b'\n')
    for path in sorted((root / 'spdx').glob('*.txt')):
        out.extend([f'--- {SUPPLEMENTAL}: spdx/{path.name}\n'.encode(), path.read_bytes(), b'\n'])
    return b''.join(out)


def verify(root, deps):
    root = Path(root)
    manifest = json.loads((root / 'manifest.json').read_bytes())
    decisions = json.loads((root / 'dispositions.json').read_bytes())['records']
    dispositions = {(d['name'], d['version']): d for d in decisions}
    records = {(r['name'], r['version']): r for r in manifest['records']}
    if len(records) != len(manifest['records']) or len(dispositions) != len(decisions):
        raise ValueError('duplicate notice or disposition')
    lock = (root / 'Cargo.lock').read_bytes()
    if digest(lock) != manifest['cargo_lock_sha256']:
        raise ValueError('Cargo.lock checksum mismatch')
    # TOML support is intentionally unnecessary on the base image Python.
    import re
    checksums = {}
    for block in lock.decode().split('[[package]]')[1:]:
        fields = dict(re.findall(r'^(\w+) = "([^"]*)"', block, re.M))
        if 'checksum' in fields:
            checksums[(fields['name'], fields['version'])] = fields['checksum']
    for key, r in records.items():
        if r['crate_sha256'] != checksums.get(key) or r['lock_checksum'] != r['crate_sha256']:
            raise ValueError(f'crate checksum mismatch: {key}')
        for f in r['files']:
            data = (root / 'crates' / f"{r['name']}-{r['version']}" / f['path']).read_bytes()
            if digest(data) != f['sha256'] or len(data) != f['size']:
                raise ValueError(f'upstream notice changed: {key} {f["path"]}')
        if not r['files']:
            d = dispositions.get(key)
            if not d or d['crate_sha256'] != r['crate_sha256'] or d['notice'] != DECLARED:
                raise ValueError(f'missing exact-version disposition: {key}')
            if key == ('priority-queue', '2.7.0') and d['distribution_license'] != 'MPL-2.0':
                raise ValueError('priority-queue must use MPL-2.0')
            for path in r['declared_only']['supplemental_spdx_texts']:
                if not (root / path).is_file():
                    raise ValueError(f'missing supplemental text: {path}')
    for path, sha256 in manifest['supplemental_sha256'].items():
        if digest((root / path).read_bytes()) != sha256:
            raise ValueError(f'supplemental SPDX text changed: {path}')
    expected = render(root, manifest, dispositions)
    if (root / 'THIRD-PARTY-NOTICES-uv.txt').read_bytes() != expected:
        raise ValueError('shipped notice entry/text differs from verified manifest and disposition')
    for name, raw in deps.items():
        packages = json.loads(raw)['packages']
        if not packages:
            raise ValueError(f'empty closure: {name}')
        for p in packages:
            key = (p['name'], p['version'])
            # Only the exact first-party workspace packages are exempt.
            if p.get('source') == 'local' and key in {tuple(x) for x in manifest['first_party']}:
                continue
            if key not in records:
                raise ValueError(f'missing notice entry or exact-version disposition: {name}: {key}')
        normalized = (json.dumps(json.loads(raw), indent=2, sort_keys=True) + '\n').encode()
        if digest(normalized) != manifest['dep_v0'][name]:
            raise ValueError(f'closure changed: {name}; regenerate notices and ask Mindi for any new declared-only disposition')
    return len(records)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('notices', type=Path)
    parser.add_argument('--bin-dir', type=Path, help='read actual uv and uvx ELF sections')
    args = parser.parse_args()
    deps = {f'{name}.dep-v0.json': dep_section(args.bin_dir / name) if args.bin_dir else
            (args.notices / f'{name}.dep-v0.json').read_bytes() for name in ('uv', 'uvx')}
    print(f'uv/uvx notice coverage OK: {verify(args.notices, deps)} third-party crates')


if __name__ == '__main__':
    main()
