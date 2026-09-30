#!/usr/bin/env python3
"""Fail-closed, offline verification of the reviewed Hermes candidate contract.

The record is trusted ONLY when read from reviewed main by the workflow. Reports
are evidence from qualification, not executable inputs or a replacement for scans.
"""
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tarfile
import zipfile

DESTINATION = 'ghcr.io/hexorx/agent-box-hermes'
SHA = r'[0-9a-f]{64}'
COMMIT = r'[0-9a-f]{40}'
DIGEST = r'sha256:' + SHA
REPORTS = {'sbom', 'provenance', 'notices', 'secrets', 'vulnerabilities', 'smoke', 'source', 'review'}
SMOKES = {'no_github_no_tailscale_boot', 'desktop_auth', 'screenshot', 'click', 'type',
          'memory_recreation', 'second_box_isolation', 'api_stream', 'api_cancel',
          'api_retry', 'shutdown', 'secret_redaction'}
DISCLOSURES = {'path_parity', 'args_escaped', 'generic_smoke_skipped', 'agent_browser_absent',
               'font_aliases', 'shared_notice_hashes', 'archive_scan_error',
               'historical_bin_docker_missing', 'declared_only', 'native_static_build_source',
               'tofu', 'source_lock_superset'}
MAX_BYTES = 64 * 1024**3


def require(condition, message):
    if not condition:
        raise ValueError(message)


def match(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def digest_file(path):
    with open(path, 'rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'duplicate JSON key')
        result[key] = value
    return result


def read_json(path):
    require(Path(path).stat().st_size <= 16 * 1024**2, 'JSON too large')
    return json.loads(Path(path).read_bytes(), object_pairs_hook=no_duplicates)


def timestamp(value):
    require(isinstance(value, str) and value.endswith('Z'), 'UTC timestamp required')
    return dt.datetime.fromisoformat(value[:-1] + '+00:00')


def validate_record(record, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    require(record['schema_version'] == 1, 'unsupported record schema')
    require(record['destination'] == DESTINATION, 'destination is fixed')
    for field in ('source_commit', 'accepted_commit'):
        require(match(COMMIT, record[field]), 'invalid source commit')
    require(match(r'v[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?', record['version']), 'invalid version')
    require(match(DIGEST, record['manifest_digest']) and match(DIGEST, record['platform_manifest_digest']), 'invalid manifest digest')
    require(record['index_digest'] in {None, record['manifest_digest']}, 'index identity mismatch')
    require(match(SHA, record['archive_sha256']), 'invalid archive digest')
    require(match(SHA, record['bundle_sha256']), 'invalid bundle digest')
    created, expires = timestamp(record['created_at']), timestamp(record['expires_at'])
    require(created <= now < expires <= created + dt.timedelta(days=7), 'stale/future evidence record')
    require(match(r'https://paperclip\.mindi\.stayho\.me/HEX/issues/HEX-97#(?:comment|document)-[a-zA-Z0-9-]+', record['ticket_record']), 'pre-push ticket record required')
    require(set(record['reports']) == REPORTS, 'missing/extra evidence reports')
    require(1 <= len(record['assets']) <= 64, 'invalid asset count')
    ids = []
    for asset in record['assets']:
        require(type(asset['id']) is int and asset['id'] > 0, 'invalid asset id')
        require(type(asset['size']) is int and 0 < asset['size'] <= 1024**3, 'invalid asset size')
        require(match(SHA, asset['sha256']), 'invalid asset digest')
        ids.append(asset['id'])
    require(len(ids) == len(set(ids)), 'duplicate asset id')
    require(sum(a['size'] for a in record['assets']) <= MAX_BYTES, 'bundle too large')
    files = {'image.oci.tar'}
    for kind, evidence in record['reports'].items():
        require(evidence['file'] == kind + '.json', 'fixed report filename required')
        require(match(SHA, evidence['sha256']), 'invalid report digest')
        files.add(evidence['file'])
    require(isinstance(record['attachments'], dict) and record['attachments'], 'raw evidence attachments required')
    for name, digest in record['attachments'].items():
        require(match(r'raw-[a-z0-9][a-z0-9_.-]{0,120}', name), 'unsafe attachment name')
        require(match(SHA, digest), 'invalid attachment digest')
        files.add(name)
    return files


def unpack_bundle(record, bundle, output):
    files = validate_record(record)
    require(digest_file(bundle) == record['bundle_sha256'], 'bundle digest mismatch')
    output = Path(output)
    output.mkdir(mode=0o700)  # Existing paths are refused; no overwrite or cleanup.
    with zipfile.ZipFile(bundle) as archive:
        entries = archive.infolist()
        require(len(entries) == len(files) and {i.filename for i in entries} == files, 'missing/extra/duplicate bundle entries')
        require(sum(i.file_size for i in entries) <= MAX_BYTES, 'unpacked bundle too large')
        for entry in entries:
            mode = entry.external_attr >> 16
            require(not stat.S_ISLNK(mode) and not entry.is_dir(), 'bundle links/directories forbidden')
            require(not (entry.flag_bits & 1), 'encrypted bundle forbidden')
            require(entry.compress_type == zipfile.ZIP_STORED, 'ZIP store mode required')
            with archive.open(entry) as source, (output / entry.filename).open('xb') as target:
                while chunk := source.read(1024**2):
                    target.write(chunk)
    return verify_candidate(record, output)


def verify_provenance(statement, source_commit):
    """Supported BuildKit local-context schemas; metadata still needs native review."""
    require(statement.get('_type') in {'https://in-toto.io/Statement/v0.1', 'https://in-toto.io/Statement/v1'}, 'unsupported in-toto statement')
    predicate = statement.get('predicate')
    require(isinstance(predicate, dict), 'native provenance predicate missing')
    kind = statement.get('predicateType')
    if kind == 'https://slsa.dev/provenance/v0.2':
        require(predicate.get('buildType') == 'https://mobyproject.org/buildkit@v1', 'unsupported provenance builder')
        metadata = predicate.get('metadata', {}).get('https://mobyproject.org/buildkit@v1#metadata', {})
    elif kind == 'https://slsa.dev/provenance/v1':
        require(predicate.get('buildDefinition', {}).get('buildType') == 'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md', 'unsupported provenance builder')
        metadata = predicate.get('runDetails', {}).get('metadata', {}).get('buildkit_metadata', {})
    else:
        raise ValueError('unsupported native provenance schema')
    vcs = metadata.get('vcs', {})
    require(vcs.get('source') in {'https://github.com/hexorx/mindi', 'https://github.com/hexorx/mindi.git'}, 'native provenance repository mismatch')
    require(vcs.get('revision') == source_commit, 'native provenance revision mismatch')


def verify_oci(path, expected, source_commit):
    """Hash every blob without extracting any paths, and bind config/layers to manifest."""
    with tarfile.open(path, mode='r:') as archive:
        members = {}
        for member in archive:
            name = member.name
            require(name not in members, 'duplicate OCI member')
            require(member.isfile() or (member.isdir() and name in {'blobs', 'blobs/sha256'}), 'OCI links or unexpected directories forbidden')
            if member.isdir():
                members[name] = member
                continue
            require(name in {'index.json', 'oci-layout'} or match(r'blobs/sha256/' + SHA, name), 'unsafe OCI member')
            members[name] = member
            if name.startswith('blobs/'):
                with archive.extractfile(member) as stream:
                    require(hashlib.file_digest(stream, 'sha256').hexdigest() == name.split('/')[-1], 'OCI blob digest mismatch')
        def document(name):
            member = members[name]
            require(member.size <= 16 * 1024**2, 'OCI metadata too large')
            return json.loads(archive.extractfile(member).read(), object_pairs_hook=no_duplicates)
        require(document('oci-layout') == {'imageLayoutVersion': '1.0.0'}, 'invalid OCI layout')
        index = document('index.json')
        require(index['schemaVersion'] == 2 and len(index['manifests']) == 1, 'one OCI image manifest required')
        def descriptor(desc, media_types):
            require(match(DIGEST, desc['digest']) and desc['mediaType'] in media_types, 'invalid OCI descriptor')
            require(not desc.get('urls') and not desc.get('data'), 'external/embedded OCI descriptor forbidden')
            name = 'blobs/sha256/' + desc['digest'][7:]
            require(members[name].size == desc['size'], 'OCI descriptor size mismatch')
            return name
        root = index['manifests'][0]
        root_name = descriptor(root, {'application/vnd.oci.image.manifest.v1+json', 'application/vnd.oci.image.index.v1+json'})
        require(root['digest'] == expected, 'OCI manifest/index digest mismatch (config ID is not a manifest)')
        names = {root_name}
        root_doc = document(root_name)
        is_index = root['mediaType'] == 'application/vnd.oci.image.index.v1+json'
        require(is_index, 'indexed native provenance required')
        if is_index:
            require(root_doc['schemaVersion'] == 2 and len(root_doc['manifests']) == 2, 'one platform plus one provenance attestation required')
            platform = [d for d in root_doc['manifests'] if d.get('platform') == {'architecture': 'amd64', 'os': 'linux'}]
            attestations = [d for d in root_doc['manifests'] if d.get('platform') == {'architecture': 'unknown', 'os': 'unknown'}]
            require(len(platform) == len(attestations) == 1, 'unsupported index platforms')
            image_desc = platform[0]
            attestation = attestations[0]
            require(attestation.get('annotations', {}).get('vnd.docker.reference.type') == 'attestation-manifest' and attestation['annotations'].get('vnd.docker.reference.digest') == image_desc['digest'], 'attestation subject mismatch')
            att_name = descriptor(attestation, {'application/vnd.oci.image.manifest.v1+json'})
            names.add(att_name)
            att_doc = document(att_name)
            require(att_doc['schemaVersion'] == 2 and att_doc['layers'], 'invalid attestation manifest')
            names.add(descriptor(att_doc['config'], {'application/vnd.oci.image.config.v1+json'}))
            for layer in att_doc['layers']:
                name = descriptor(layer, {'application/vnd.in-toto+json'})
                names.add(name)
                statement = document(name)
                verify_provenance(statement, source_commit)
                require(statement['subject'] and all(x['digest'] == {'sha256': image_desc['digest'][7:]} for x in statement['subject']), 'in-toto subject mismatch')
        else:
            image_desc, att_doc = root, {'layers': []}
        manifest_name = descriptor(image_desc, {'application/vnd.oci.image.manifest.v1+json'})
        names.add(manifest_name)
        manifest = document(manifest_name)
        require(manifest['schemaVersion'] == 2 and manifest['mediaType'] == 'application/vnd.oci.image.manifest.v1+json', 'invalid OCI manifest')
        config_name = descriptor(manifest['config'], {'application/vnd.oci.image.config.v1+json'})
        names.add(config_name)
        config = document(config_name)
        require(config['os'] == 'linux' and config['architecture'] == 'amd64', 'linux/amd64 required')
        require(manifest['layers'], 'missing OCI layers')
        for layer in manifest['layers']:
            names.add(descriptor(layer, {'application/vnd.oci.image.layer.v1.tar', 'application/vnd.oci.image.layer.v1.tar+gzip', 'application/vnd.oci.image.layer.v1.tar+zstd'}))
        require({n for n in members if n.startswith('blobs/sha256/')} == names, 'unreferenced OCI blobs forbidden')
        return manifest, config, image_desc['digest'], is_index, att_doc['layers']


def evidence_refs(report, attachments):
    require(isinstance(report['raw'], list) and report['raw'], 'raw evidence reference required')
    require(all(name in attachments for name in report['raw']), 'raw evidence missing')


def verify_candidate(record, directory):
    validate_record(record)
    directory = Path(directory)
    require(digest_file(directory / 'image.oci.tar') == record['archive_sha256'], 'archive digest mismatch')
    manifest, config, platform_digest, is_index, att_layers = verify_oci(directory / 'image.oci.tar', record['manifest_digest'], record['source_commit'])
    require(platform_digest == record['platform_manifest_digest'] and is_index == (record['index_digest'] is not None), 'platform/index identity mismatch')
    for name, digest in record['attachments'].items():
        require(digest_file(directory / name) == digest, 'raw evidence digest mismatch')
    reports = {}
    for kind, entry in record['reports'].items():
        path = directory / entry['file']
        require(digest_file(path) == entry['sha256'], 'report digest mismatch')
        report = read_json(path)
        require(report['schema_version'] == 1 and report['kind'] == kind, 'invalid report schema')
        require(report['status'] == 'pass', 'failed/missing evidence gate: ' + kind)
        require(report['source_commit'] == record['source_commit'] and report['manifest_digest'] == record['manifest_digest'], 'evidence subject mismatch')
        observed = timestamp(report['observed_at'])
        require(dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=7) <= observed <= timestamp(record['created_at']), 'stale/future report')
        evidence_refs(report, record['attachments'])
        reports[kind] = report
    sbom = reports['sbom']
    require(sbom['format'] in {'spdx-json', 'cyclonedx-json'} and type(sbom['components']) is int and sbom['components'] > 0, 'invalid SBOM')
    provenance = reports['provenance']
    require(provenance['builder'] and provenance['build_without_package_write'] is True, 'build permission evidence missing')
    require(provenance['archive_sha256'] == record['archive_sha256'], 'provenance archive mismatch')
    require(provenance['config_digest'] == manifest['config']['digest'], 'provenance config mismatch')
    require(all(layer['digest'][7:] in {record['attachments'][name] for name in provenance['raw']} for layer in att_layers), 'raw attestation statements missing from provenance')
    source = reports['source']
    require(source['accepted_commit'] == record['accepted_commit'], 'accepted source mismatch')
    require(match(SHA, source['built_inputs_sha256']) and source['built_inputs_sha256'] == source['accepted_inputs_sha256'], 'source input equivalence missing')
    notices = reports['notices']
    require(notices['corresponding_source']['status'] == 'fulfilled', 'corresponding-source obligations unresolved')
    evidence_refs(notices['corresponding_source'], record['attachments'])
    require(notices['corresponding_source']['components'] and all(x['component'] and x['status'] in {'delivered', 'offered'} and x['evidence'] in record['attachments'] for x in notices['corresponding_source']['components']), 'component source obligations missing')
    require(DISCLOSURES <= set(notices['disclosures']) and all(isinstance(v, str) and v.strip() for v in notices['disclosures'].values()), 'accepted residual disclosures missing')
    secrets = reports['secrets']
    require(secrets['scanner']['name'] and secrets['scanner']['version'] and secrets['scanner']['ruleset'] and secrets['content_scan'] is True, 'secret scanner identity missing')
    require(secrets['filesystem'] == secrets['config_history'] == 'pass', 'incomplete secret surfaces')
    require(secrets['deleted_contents'] is True and type(secrets['findings']) is int and secrets['findings'] == 0 and secrets['errors'] == [], 'secret findings/errors')
    require(secrets['layers'] == {x['digest']: 'pass' for x in manifest['layers'] + att_layers}, 'every layer scan required')
    vulnerabilities = reports['vulnerabilities']
    require(vulnerabilities['scanner']['name'] and vulnerabilities['scanner']['version'] and vulnerabilities['database']['digest'] and vulnerabilities['database']['schema'] and vulnerabilities['input'] == 'oci-archive' and vulnerabilities['archive_sha256'] == record['archive_sha256'], 'vulnerability scanner/database missing')
    database_time = timestamp(vulnerabilities['database']['updated_at'])
    require(dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2) <= database_time <= timestamp(record['created_at']), 'stale vulnerability database')
    require(vulnerabilities['errors'] == [] and type(vulnerabilities['unresolved']) is int and vulnerabilities['unresolved'] == 0, 'vulnerability failures unresolved')
    require(vulnerabilities['disposition'] in {'clean', 'reviewed-exceptions'}, 'vulnerability disposition required')
    if vulnerabilities['disposition'] == 'reviewed-exceptions':
        require(vulnerabilities['exceptions'] and all(x['id'] and x['reason'] and x['approved_by'] and timestamp(x['expires_at']) >= timestamp(record['expires_at']) for x in vulnerabilities['exceptions']), 'invalid vulnerability exceptions')
    smoke = reports['smoke']
    require(set(smoke['checks']) == SMOKES, 'missing smoke gates')
    for check in smoke['checks'].values():
        require(check['image_digest_tested'] == record['manifest_digest'] and (check['inference_spend'] == 'none' or match(r'https://paperclip\.mindi\.stayho\.me/HEX/approvals/[a-z0-9-]+', check['inference_spend'])) and check['status'] == 'pass' and check['mode'] in {'real', 'mock'} and check['evidence'] in record['attachments'], 'failed/missing smoke evidence')
    # Mock coverage is disclosed but cannot satisfy the release gate.
    require(all(check['mode'] == 'real' for check in smoke['checks'].values()), 'mock smoke cannot qualify release')
    review = reports['review']
    require(review['commit'] == record['accepted_commit'] and review['reviewer'] != review['author'] and review['reviewer'] and review['author'], 'independent exact-head review required')
    require(review['decision'] == 'approved' and review['ci'] == 'success', 'approval/CI gate failed')
    # Upstream identity remains separate from the final standalone image revision.
    require(match(COMMIT, provenance['upstream_revision']), 'invalid upstream revision')
    require(config.get('config', {}).get('Labels', {}).get('org.opencontainers.image.revision') == record['source_commit'], 'standalone OCI revision mismatch')
    return {'manifest_digest': record['manifest_digest'], 'index_digest': record['index_digest'], 'platform_manifest_digest': platform_digest, 'config_digest': manifest['config']['digest'],
            'archive_sha256': record['archive_sha256'], 'source_commit': record['source_commit'],
            'tags': ['sha-' + record['source_commit'], record['version']]}
