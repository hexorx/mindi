#!/usr/bin/env python3
"""Reject forbidden payloads in a root filesystem or every docker-save layer.

Archive members are inspected too: deleting a live file while retaining its
wheel/npm/cache archive is not remediation. Symlinks are not followed.
"""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import zipfile

POLICY = Path(__file__).with_name('payload-policy.json')


def forbidden_path(name, policy):
    name = '/' + name.lstrip('./')
    if '/usr/share/doc/agent-box-hermes/' in name:
        return False  # historical metadata is explicitly preserved
    return ('/@photon-ai/whatsapp-business/' in name
            or '/claude_agent_sdk/_bundled/claude' in name
            or Path(name).name in policy['font_names']
            or '/chrome-headless-shell-linux64/' in name)


def inspect_stream(stream, name, policy, depth=0):
    if forbidden_path(name, policy):
        raise ValueError(f'forbidden payload path: {name}')
    first = stream.read(4)
    archive = first.startswith((b'PK\x03\x04', b'\x1f\x8b')) or name.endswith(('.tar', '.tgz', '.whl', '.zip'))
    digest = hashlib.sha256(first)
    with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024) as saved:
        if archive:
            saved.write(first)
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            if archive:
                saved.write(chunk)
        if digest.hexdigest() in policy['sha256']:
            raise ValueError(f'forbidden payload hash: {name}: {policy["sha256"][digest.hexdigest()]}')
        if not archive:
            return
        if depth >= 8:
            raise ValueError(f'archive nesting exceeds verification limit: {name}')
        saved.seek(0)
        if first.startswith(b'PK\x03\x04'):
            with zipfile.ZipFile(saved) as z:
                for member in z.infolist():
                    if not member.is_dir():
                        with z.open(member) as f:
                            inspect_stream(f, name + '!' + member.filename, policy, depth + 1)
        else:
            try:
                with tarfile.open(fileobj=saved, mode='r:*') as t:
                    inspect_tar(t, policy, name + '!', depth + 1)
            except tarfile.ReadError:
                if not first.startswith(b'\x1f\x8b'):
                    raise ValueError(f'unreadable archive: {name}') from None
                saved.seek(0)
                with gzip.GzipFile(fileobj=saved) as f:
                    inspect_stream(f, name + '!gunzip', policy, depth + 1)


def inspect_tar(archive, policy, prefix='', depth=0):
    count = 0
    for member in archive:
        if member.isfile():
            with archive.extractfile(member) as f:
                inspect_stream(f, prefix + member.name, policy, depth)
            count += 1
        elif member.issym() or member.islnk():
            if forbidden_path(member.name, policy) or forbidden_path(member.linkname, policy):
                raise ValueError(f'forbidden payload link: {prefix}{member.name}')
    return count


def inspect_docker_save(path, policy):
    with tarfile.open(path, 'r:*') as image:
        manifest = json.load(image.extractfile('manifest.json'))
        layers = sorted({layer for entry in manifest for layer in entry['Layers']})
        if not layers:
            raise ValueError('image has no layers')
        count = 0
        for layer in layers:
            with image.extractfile(layer) as stream, tarfile.open(fileobj=stream, mode='r|*') as archive:
                count += inspect_tar(archive, policy, layer + ':')
    return {'layers': len(layers), 'files': count}


def inspect_root(root, policy):
    # Share filesystem traversal with the sanitizer, without changing anything.
    from sanitize_payloads import files
    count = 0
    for path in files(root):
        with path.open('rb') as stream:
            inspect_stream(stream, str(path.relative_to(root)), policy)
        count += 1
    return {'files': count}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--root', type=Path)
    mode.add_argument('--docker-save', type=Path)
    args = parser.parse_args()
    policy = json.loads(POLICY.read_text())
    result = (inspect_root(args.root, policy) if args.root else
              inspect_docker_save(args.docker_save, policy))
    print(json.dumps({'result': 'PASS', **result}, sort_keys=True))


if __name__ == '__main__':
    main()
