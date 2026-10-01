"""Apply the installed-tree security lock without running npm lifecycle scripts.

The immutable base supplies the rest of each dependency tree. Preserve nested
node_modules, validate old versions, and verify every archive before modifying
anything. This overlay, not upstream install locks, describes the shipped tree.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
import urllib.request


def unpack(raw, entry, destination):
    if hashlib.sha256(raw).hexdigest() != entry['sha256']:
        raise ValueError('archive hash mismatch: ' + entry['name'])
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        for member in archive.getmembers():
            parts = PurePosixPath(member.name).parts
            if (not parts or parts[0] != 'package' or '..' in parts
                    or (len(parts) > 1 and parts[1] == 'node_modules')
                    or not (member.isfile() or member.isdir())):
                raise ValueError('unsafe archive member: ' + member.name)
        archive.extractall(destination, filter='data')
    package = json.loads((destination / 'package/package.json').read_text())
    if (package['name'], package['version'], package.get('dependencies', {})) != (
            entry['name'], entry['version'], entry['dependencies']):
        raise ValueError('archive metadata mismatch')
    return destination / 'package'


def target_path(root, target, entry):
    path = target['path']
    if not path.startswith(('/opt/hermes/', '/usr/local/lib/node_modules/npm/node_modules/')):
        raise ValueError('target outside permitted trees')
    full = root / path.lstrip('/')
    if full.resolve() != full or not full.is_relative_to(root):
        raise ValueError('target traverses symlink or parent')
    old = json.loads((full / 'package.json').read_text())
    if (old['name'], old['version']) != (entry['name'], target['expectedVersion']):
        raise ValueError('inherited package mismatch: ' + path)
    return full


def apply(root, lock, fetch):
    root = root.resolve()
    if lock['schemaVersion'] != 1:
        raise ValueError('unsupported lock schema')
    with tempfile.TemporaryDirectory() as scratch:
        prepared = []
        for i, entry in enumerate(lock['packages']):
            targets = [target_path(root, target, entry) for target in entry['targets']]
            stage = Path(scratch) / str(i)
            stage.mkdir()
            source = unpack(fetch(entry['url']), entry, stage)
            prepared.append((source, targets))
        # All downloads, hashes and inherited identities have passed.
        for source, targets in prepared:
            for target in targets:
                for child in target.iterdir():
                    if child.name != 'node_modules':
                        if child.is_dir() and not child.is_symlink():
                            shutil.rmtree(child)
                        else:
                            child.unlink()
                shutil.copytree(source, target, dirs_exist_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('/'))
    parser.add_argument('--lock', type=Path, required=True)
    args = parser.parse_args()
    apply(args.root, json.loads(args.lock.read_text()),
          lambda url: urllib.request.urlopen(url, timeout=60).read())
