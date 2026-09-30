#!/usr/bin/env python3
"""Join a final filesystem Syft SBOM and interpreter inventories to shipped notices.

Read-only on the image and historical evidence. Run outside the image against
its exported filesystem. Output is an additive evidence overlay, not legal
closure or proof that Cargo.lock candidates are linked into binaries.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

DOCS = 'usr/share/doc/agent-box-hermes/third-party'
TYPES = {'sbom-npm': 'npm', 'sbom-python': 'python',
         'sbom-rust-crate': 'rust-crate', 'sbom-go-module': 'go-module',
         'sbom-binary': 'binary', 'debian': 'deb'}
EXCLUDED = {'@photon-ai/slack', '@photon-ai/whatsapp-business'}


def canonical(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def inside(root, name):
    """Do not follow image symlinks into the host collecting evidence."""
    path = root / name.lstrip('/')
    if '..' in Path(name).parts or not path.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'path escapes exported root: {name}')
    return path


def paths(row):
    return sorted({x.get('path', x.get('accessPath', '')) for x in row.get('locations', [])} - {''})


def key(kind, name, version):
    return kind, canonical(name) if kind == 'python' else name, version


def shipped_text(root, relative):
    path = inside(root, DOCS + '/' + relative)
    if not path.is_file():
        raise ValueError(f'missing shipped notice: {relative}')
    return {'path': '/' + DOCS + '/' + relative, 'sha256': sha(path)}


def modified(name):
    return canonical(name) in {'hindsight-api', 'hindsight', 'pg0-embedded',
                               'claude-agent-sdk', '@spectrum-ts/whatsapp-business',
                               '@spectrum-ts/slack', '@nous-research/ui'}


def reconcile(root, sbom, inventories, source_head, image):
    if not re.fullmatch(r'[0-9a-f]{40}', source_head):
        raise ValueError('full source head required')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        raise ValueError('exact image digest required')
    scope = sbom.get('source', {}).get('metadata', {}).get('scope')
    # Syft directory scans have no scope field; image scans must be squashed.
    if scope not in (None, 'squashed') or sbom.get('source', {}).get('type') not in ('directory', 'image'):
        raise ValueError('require final filesystem/directory or squashed image SBOM')
    if not sbom.get('descriptor', {}).get('version'):
        raise ValueError('SBOM tool/version required')
    bundle = inside(root, DOCS)
    baseline_path = bundle / 'reconciliation.json'
    baseline = json.loads(baseline_path.read_text())['rows']
    manifest = json.loads((bundle / 'manifest.json').read_text())
    texts_by_original = {}
    for row in manifest['notices']:
        ref = shipped_text(root, row['file'])
        if ref['sha256'] != row['sha256']:
            raise ValueError(f'changed historical notice: {row["file"]}')
        texts_by_original.setdefault('/' + row['original_path'].lstrip('/'), []).append(ref)
    supplement = 'hex195-provenance-join/prior-reconciliation/overlay.json'
    supplement_rows = json.loads((bundle / supplement).read_text())['rows']
    if len(supplement_rows) != len(baseline):
        raise ValueError('supplement/baseline row count differs')
    by_identity = {}
    for i, row in enumerate(baseline):
        kind = TYPES.get(row['kind'], row['kind'])
        by_identity.setdefault(key(kind, row['name'], row['version']), []).append(i)

    artifacts = sbom['artifacts']
    if not artifacts:
        raise ValueError('empty final SBOM')
    final_by_key = {}
    final_rows = []
    for artifact in artifacts:
        kind = artifact['type']
        name, version = artifact['name'], artifact['version']
        locations = paths(artifact)
        # Scan evidence files are historical metadata, never current components.
        historical = locations and all(p.lstrip('/').startswith(DOCS + '/') for p in locations)
        if name in EXCLUDED and not historical:
            raise ValueError(f'excluded provider in final SBOM: {name}')
        index = [] if historical else by_identity.get(key(kind, name, version), [])
        refs = {}
        for i in index:
            for text in baseline[i].get('texts', []):
                ref = shipped_text(root, text)
                refs[ref['path']] = ref
        for location in locations:
            # Direct installed notices (not dependency notices) and exact
            # original-path associations both remain explicit in the output.
            if location.endswith('/package.json') and not historical:
                parent = inside(root, location).parent
                for path in parent.iterdir() if parent.is_dir() else []:
                    if path.is_file() and not path.is_symlink() and path.name.lower().startswith(('license', 'copying', 'notice')):
                        ref = {'path': '/' + path.relative_to(root).as_posix(), 'sha256': sha(path)}
                        refs[ref['path']] = ref
            for ref in texts_by_original.get(location, []):
                refs[ref['path']] = ref
        row = {'artifact_id': artifact['id'], 'kind': kind, 'name': name,
               'version': version, 'locations': locations,
               'membership': 'historical-evidence-only' if historical else
                             ('modified' if modified(name) else 'observed-final-sbom'),
               'baseline_rows': index, 'texts': list(refs.values()),
               'notice_status': 'mapped-texts-needs-review' if refs else 'needs-disposition',
               'source_status': 'not_reconciled',
               'supplement_rows': [dict(file=supplement, row=i) for i in index]}
        final_rows.append(row)
        if not historical:
            final_by_key.setdefault(key(kind, name, version), []).append(row)

    installed = []
    installed_keys = set()
    environments = set()
    for inventory in inventories:
        env = inventory['python']['executable']
        environments.add(env)
        for kind, packages in [('python', inventory['python']['packages']), ('deb', inventory.get('debian', []))]:
            for package in packages:
                ident = key(kind, package['name'], package['version'])
                installed_keys.add((env if kind == 'python' else '', ident))
                refs = []
                for notice in package['notices']:
                    path = inside(root, notice['path'])
                    if sha(path) != notice['sha256']:
                        raise ValueError(f'inventory notice hash mismatch: {path}')
                    refs.append({'path': notice['path'], 'sha256': notice['sha256']})
                installed.append({'kind': kind, 'name': package['name'], 'version': package['version'],
                                  'environment': env if kind == 'python' else None,
                                  'membership': 'modified' if modified(package['name']) else 'installed',
                                  'texts': refs, 'baseline_rows': by_identity.get(ident, []),
                                  'sbom_artifact_ids': [r['artifact_id'] for r in final_by_key.get(ident, [])],
                                  'source_package': package.get('source_package'),
                                  'source_version': package.get('source_version'),
                                  'source_status': 'not_reconciled'})
    expected_envs = {r['environment'] for r in baseline if r['kind'] == 'python'}
    if not expected_envs <= environments:
        raise ValueError(f'missing Python environments: {sorted(expected_envs - environments)}')
    if not any(r['kind'] == 'deb' for r in installed):
        raise ValueError('missing final Debian inventory')

    overlay = []
    for i, row in enumerate(baseline):
        kind = TYPES.get(row['kind'], row['kind'])
        ident = key(kind, row['name'], row['version'])
        candidates = final_by_key.get(ident, [])
        old_paths = paths(row)
        # Locations must agree as well as name/version for historical SBOM rows.
        matches = [r for r in candidates if not old_paths or set(old_paths) & set(r['locations'])]
        if row['kind'] in ('cua-rust-lock-candidate', 'pg0-rust'):
            membership = 'candidate-only'
        elif row['kind'] == 'python':
            membership = 'installed' if (row['environment'], ident) in installed_keys else 'absent-from-environment'
        elif row['kind'] == 'debian':
            membership = 'installed' if ('', ident) in installed_keys else 'absent-from-dpkg'
        elif row['kind'] == 'retained-cache':
            membership = 'retained-path' if inside(root, row['name']).exists() else 'removed'
        elif matches:
            membership = 'observed-final-sbom'
        elif row['name'] == 'playwright-core' and row['version'] == '1.62.1' and candidates:
            membership = 'relocated'
            matches = candidates
        elif old_paths and not any(inside(root, p).exists() for p in old_paths):
            membership = 'removed'
        else:
            membership = 'needs-membership-review'
        if membership in ('installed', 'observed-final-sbom') and modified(row['name']):
            membership = 'modified'
        overlay.append({'baseline_row_index': i, 'kind': row['kind'], 'name': row['name'],
                        'version': row['version'], 'membership': membership,
                        'final_artifact_ids': [r['artifact_id'] for r in matches],
                        'texts': [shipped_text(root, t) for t in row.get('texts', [])],
                        'source_status': row['source_status'],
                        'prior_disposition': {'file': supplement, 'row': i},
                        'source_action': row.get('source_action'),
                        'prior_membership': row.get('membership')})
    report_path = bundle / 'payload-remediation.json'
    return {'schema_version': 1, 'complete': False, 'source_head': source_head, 'image': image,
            'coverage': {'sbom_tool': sbom['descriptor'], 'sbom_source': sbom['source'],
                         'python_environments': sorted(environments),
                         'limitations': ['SBOM detection is not complete embedded/native linkage evidence.',
                                         'Source-lock candidates remain supersets.',
                                         'Historical source_status and accepted residuals are unchanged.',
                                         'Added Debian corresponding-source evidence requires separate review.']},
            'baseline_sha256': sha(baseline_path), 'baseline_rows': overlay,
            'final_sbom_rows': final_rows, 'installed_rows': installed,
            'remediation': json.loads(report_path.read_text()),
            'excluded': [{'name': name, 'membership': 'excluded', 'reason': 'no license grant'} for name in sorted(EXCLUDED)],
            'accepted_dispositions': ['NOTICE-STATUS.md', 'hex195-provenance-join/final-disposition.json'],
            'pending_membership_rows': [r['baseline_row_index'] for r in overlay if r['membership'] == 'needs-membership-review']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--sbom', type=Path, required=True)
    parser.add_argument('--inventory', type=Path, action='append', required=True)
    parser.add_argument('--source-head', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = reconcile(args.root.resolve(), json.loads(args.sbom.read_text()),
                       [json.loads(p.read_text()) for p in args.inventory], args.source_head, args.image)
    result['inputs'] = [{'path': str(p), 'sha256': sha(p)} for p in [args.sbom, *args.inventory]]
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')


if __name__ == '__main__':
    main()
