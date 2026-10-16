#!/usr/bin/env python3
"""Scan every docker-save layer, including deleted files, plus config/history.

Reports contain locations and rule IDs only, never matched secret values.
Reviewed non-secret fixtures are matched by path, file bytes, rule and line;
the old layer digest is deliberately not reused after a rebuild.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]


def safe_name(name):
    path = PurePosixPath(name)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Unsafe archive path')
    return str(path)


def scan(directory, allowlist):
    result = subprocess.run(['trivy', 'fs', '--scanners', 'secret', '--format', 'json',
                             '--quiet', str(directory)], capture_output=True, check=True)
    report = json.loads(result.stdout)
    if report.get('SchemaVersion') != 2 or not isinstance(report.get('Results', []), list):
        raise ValueError('Invalid scanner report')
    findings = []
    for item in report.get('Results', []):
        # Package-only results use descriptive Targets, not file paths.
        if not item.get('Secrets'):
            continue
        target = Path(item['Target'])
        if target.is_absolute():
            target = target.relative_to(directory)
        target = Path(safe_name(str(target)))
        source = directory / target
        for finding in item.get('Secrets', []):
            with source.open('rb') as stream:
                digest = hashlib.file_digest(stream, 'sha256').hexdigest()
            path = '/' + target.as_posix()
            allowed = any(row['path'] == path and row['file_sha256'] == digest
                          and row['rule_id'] == finding['RuleID']
                          and finding['StartLine'] in row['lines'] for row in allowlist)
            if not allowed:
                findings.append({'path': path, 'rule': finding['RuleID'],
                                 'line': finding['StartLine']})
    return findings


def check(archive_path, output):
    allowlist = json.loads((ROOT / 'apps/agent-box-hermes/security/secret-allowlist.json').read_text())['entries']
    scratch = Path(tempfile.mkdtemp(prefix='hermes-layer-scan-', dir=os.environ.get('RUNNER_TEMP')))
    findings, surfaces = [], []
    with tarfile.open(archive_path) as archive:
        manifests = json.load(archive.extractfile('manifest.json'))
        if len(manifests) != 1 or not manifests[0]['Layers']:
            raise ValueError('Expected one nonempty image')
        manifest = manifests[0]
        metadata = scratch / 'metadata'
        metadata.mkdir(mode=0o700)
        (metadata / 'config.json').write_bytes(archive.extractfile(safe_name(manifest['Config'])).read())
        findings.extend(scan(metadata, []))
        surfaces.append('config/history')
        for i, layer in enumerate(manifest['Layers']):
            directory = scratch / str(i)
            directory.mkdir(mode=0o700)
            with archive.extractfile(safe_name(layer)) as stream:
                with tarfile.open(fileobj=stream, mode='r|*') as contents:
                    for member in contents:
                        name = safe_name(member.name)
                        # No link extraction or overlay application. Every regular
                        # file is scanned even if a later whiteout removes it.
                        if member.isfile():
                            target = directory / name
                            target.parent.mkdir(parents=True, exist_ok=True)
                            with target.open('xb') as out, contents.extractfile(member) as source:
                                import shutil
                                shutil.copyfileobj(source, out)
            findings.extend({'layer': i, **row} for row in scan(directory, allowlist))
            surfaces.append(layer)
    output.write_text(json.dumps({'surfaces': surfaces, 'findings': findings}, indent=2) + '\n')
    if findings:
        raise ValueError('Secret scan failed; see value-redacted report')


if __name__ == '__main__':
    try:
        check(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception:
        raise SystemExit('Layer secret scan failed (details redacted)') from None
