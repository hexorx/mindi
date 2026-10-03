#!/usr/bin/env python3
"""Check required licensing bytes in the final filesystem of the published OCI.

Presence is not a legal/completeness determination. Packaging inputs still need
candidate-specific review; historical bundles cannot clear a different image.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

REQUIRED = ('usr/share/doc/agent-box-hermes/LICENSE',
            'usr/share/doc/agent-box-hermes/THIRD-PARTY-NOTICES')
MAX_DOCUMENT = 32 * 1024 * 1024


def canonical(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Unsafe archive path')
    return str(path)


def blob(archive, digest):
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
        raise ValueError('Expected SHA256 blob')
    member = archive.getmember('blobs/sha256/' + digest.split(':')[1])
    if not member.isfile():
        raise ValueError('Expected regular blob')
    stream = archive.extractfile(member)
    checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
    if checksum != digest.split(':')[1]:
        raise ValueError('Blob digest mismatch')
    stream.seek(0)
    return stream


def json_blob(archive, digest):
    with blob(archive, digest) as stream:
        raw = stream.read(MAX_DOCUMENT + 1)
        if len(raw) > MAX_DOCUMENT:
            raise ValueError('Oversized metadata')
        return json.loads(raw)


def final_documents(archive, layers):
    documents = {}
    for layer in layers:
        additions, removals = {}, []
        # OCI whiteouts remove lower-layer entries, regardless of tar ordering.
        with blob(archive, layer['digest']) as stream, tarfile.open(fileobj=stream, mode='r|*') as tar:
            for member in tar:
                name = canonical(member.name)
                path = PurePosixPath(name)
                if path.name == '.wh..wh..opq':
                    removals.append(str(path.parent))
                    continue
                if path.name.startswith('.wh.'):
                    removals.append(str(path.parent / path.name[4:]))
                    continue
                relevant = [p for p in REQUIRED if p == name or p.startswith(name + '/')]
                if not relevant:
                    continue
                if member.isdir() and name not in REQUIRED:
                    continue
                if name not in REQUIRED:
                    raise ValueError("Non-directory ancestor of required license/notices")
                # Every required-path entry replaces captured bytes, including
                # directories and duplicate entries within the same layer.
                # Only regular files can supply a document.
                for target in relevant:
                    additions[target] = None
                if name in REQUIRED and member.isfile():
                    if member.size > MAX_DOCUMENT:
                        raise ValueError('Oversized required license/notices')
                    additions[name] = tar.extractfile(member).read()
        for path in removals:
            for target in REQUIRED:
                if path == '.' or target == path or target.startswith(path + '/'):
                    documents.pop(target, None)
        documents.update(additions)
    for path in REQUIRED:
        data = documents.get(path)
        if not data or not data.strip():
            raise ValueError('Missing/empty/non-regular required license/notices: /' + path)
    return [{'path': '/' + path, 'size': len(documents[path]),
             'sha256': hashlib.sha256(documents[path]).hexdigest()} for path in REQUIRED]


def check(image, source, report=None):
    if not re.fullmatch(r'[0-9a-f]{40}', source):
        raise ValueError('Expected full source SHA')
    with tarfile.open(image) as archive:
        # Duplicate blob names make archive interpretation ambiguous.
        names = [m.name for m in archive.getmembers()]
        if len(names) != len(set(names)):
            raise ValueError('Duplicate archive members')
        if not archive.getmember('index.json').isfile():
            raise ValueError('Expected regular OCI index')
        index = json.load(archive.extractfile('index.json'))
        if len(index['manifests']) != 1:
            raise ValueError('Expected one platform manifest')
        digest = index['manifests'][0]['digest']
        manifest = json_blob(archive, digest)
        config = json_blob(archive, manifest['config']['digest'])
        if config['config']['Labels']['org.opencontainers.image.revision'] != source:
            raise ValueError('Built source does not match workflow source')
        documents = final_documents(archive, manifest['layers'])
    evidence = {'status': 'passed', 'workflow_sha': source, 'built_source_sha': source,
                'manifest_digest': digest, 'documents': documents}
    if report is not None:
        Path(report).write_text(json.dumps(evidence, indent=2) + '\n')
    return evidence


if __name__ == '__main__':
    try:
        check(Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]))
    except Exception:
        raise SystemExit('License/notices gate refused publication; required candidate bytes or source identity invalid') from None
