"""Synthetic offline candidates; no Docker, registry, credentials or paid inference."""
import copy
import datetime as dt
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import zipfile

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts/hermes-release'))
import gate
import promote
from smoke_fixtures import fixture


def encoded(value):
    return json.dumps(value, sort_keys=True).encode()


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Candidate:
    def __init__(self, root, indexed=True, mutate_statement=None, revision=None):
        self.root = root
        self.source = 'a' * 40
        self.now = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        date = lambda value: value.isoformat().replace('+00:00', 'Z')
        self.blobs = {}
        def blob(data, media):
            digest = sha(data)
            self.blobs['blobs/sha256/' + digest] = data
            return {'digest': 'sha256:' + digest, 'size': len(data), 'mediaType': media}
        config = blob(encoded({'os': 'linux', 'architecture': 'amd64', 'config': {'Labels': {'org.opencontainers.image.revision': revision or self.source}}}), 'application/vnd.oci.image.config.v1+json')
        layer = blob(b'fixture layer only', 'application/vnd.oci.image.layer.v1.tar')
        manifest = {'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'config': config, 'layers': [layer]}
        platform = blob(encoded(manifest), manifest['mediaType'])
        self.manifest = manifest
        desc = copy.deepcopy(platform)
        layers = [layer]
        if indexed:
            native = {'_type': 'https://in-toto.io/Statement/v0.1',
                      'subject': [{'name': '_', 'digest': {'sha256': platform['digest'][7:]}}],
                      'predicateType': 'https://slsa.dev/provenance/v0.2',
                      'predicate': {'buildType': 'https://mobyproject.org/buildkit@v1',
                                    'metadata': {'https://mobyproject.org/buildkit@v1#metadata': {
                                        'vcs': {'source': 'https://github.com/hexorx/mindi.git', 'revision': self.source}}}}}
            if mutate_statement:
                mutate_statement(native)
            statement = blob(encoded(native), 'application/vnd.in-toto+json')
            att = blob(encoded({'schemaVersion': 2, 'mediaType': manifest['mediaType'], 'config': config, 'layers': [statement]}), manifest['mediaType'])
            desc['platform'] = {'os': 'linux', 'architecture': 'amd64'}
            att['platform'] = {'os': 'unknown', 'architecture': 'unknown'}
            att['annotations'] = {'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': platform['digest']}
            desc = blob(encoded({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': [desc, att]}), 'application/vnd.oci.image.index.v1+json')
            layers.append(statement)
        files = {**self.blobs, 'oci-layout': encoded({'imageLayoutVersion': '1.0.0'}), 'index.json': encoded({'schemaVersion': 2, 'manifests': [desc]})}
        with tarfile.open(root / 'image.oci.tar', 'w') as archive:
            for name, data in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
        self.record = {'schema_version': 1, 'destination': gate.DESTINATION, 'source_commit': self.source, 'accepted_commit': 'b' * 40,
                       'version': 'v1.2.3', 'manifest_digest': desc['digest'], 'platform_manifest_digest': platform['digest'],
                       'index_digest': desc['digest'] if indexed else None, 'archive_sha256': gate.digest_file(root / 'image.oci.tar'),
                       'created_at': date(self.now), 'expires_at': date(self.now + dt.timedelta(days=1)),
                       'ticket_record': 'https://paperclip.mindi.stayho.me/HEX/issues/HEX-97#document-release-evidence',
                       'assets': [{'id': 42, 'size': 1, 'sha256': '0' * 64}], 'bundle_sha256': '0' * 64,
                       'reports': {}, 'attachments': {'raw-evidence.json': sha(b'{}')}}
        (root / 'raw-evidence.json').write_bytes(b'{}')
        self.reports = {kind: {'schema_version': 1, 'kind': kind, 'source_commit': self.source, 'manifest_digest': desc['digest'],
                               'status': 'pass', 'observed_at': date(self.now), 'raw': ['raw-evidence.json']} for kind in gate.REPORTS}
        self.reports['sbom'].update(format='spdx-json', components=1)
        self.reports['provenance'].update(builder='fixture', build_without_package_write=True, archive_sha256=self.record['archive_sha256'], config_digest=config['digest'], upstream_revision='e'*40)
        self.reports['source'].update(accepted_commit='b'*40, built_inputs_sha256='d'*64, accepted_inputs_sha256='d'*64)
        self.reports['notices'].update(corresponding_source={'status': 'fulfilled', 'raw': ['raw-evidence.json'], 'components': [{'component': 'fixture', 'status': 'delivered', 'evidence': 'raw-evidence.json'}]}, disclosures={k: 'Fixture disclosure; not release evidence' for k in gate.DISCLOSURES})
        self.reports['secrets'].update(scanner={'name': 'fixture', 'version': '1', 'ruleset': 'fixture'}, content_scan=True, filesystem='pass', config_history='pass', deleted_contents=True, findings=0, errors=[], layers={x['digest']: 'pass' for x in layers})
        self.reports['vulnerabilities'].update(scanner={'name': 'fixture', 'version': '1'}, database={'digest': 'fixture', 'schema': 'fixture', 'updated_at': date(self.now)}, input='oci-archive', archive_sha256=self.record['archive_sha256'], errors=[], unresolved=0, disposition='clean')
        self.reports['smoke'], smoke_raw = fixture(desc['digest'], self.source, date(self.now))
        for name, data in smoke_raw.items():
            (root / name).write_bytes(data)
            self.record['attachments'][name] = sha(data)
        self.reports['review'].update(commit='b'*40, author='codi', reviewer='devi', decision='approved', ci='success')
        if indexed:
            raw = self.blobs['blobs/sha256/' + statement['digest'][7:]]
            (root / 'raw-attestation.json').write_bytes(raw)
            self.record['attachments']['raw-attestation.json'] = sha(raw)
            self.reports['provenance']['raw'].append('raw-attestation.json')
        self.seal()

    def seal(self):
        for kind, report in self.reports.items():
            path = self.root / (kind + '.json')
            path.write_bytes(encoded(report))
            self.record['reports'][kind] = {'file': path.name, 'sha256': gate.digest_file(path)}

    def bundle(self, output, extra=None):
        with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED) as archive:
            for path in self.root.iterdir():
                archive.write(path, path.name)
            if extra:
                archive.writestr(*extra)
        self.record['bundle_sha256'] = gate.digest_file(output)
        return output


class GateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        self.c = Candidate(self.data)

    def verify(self):
        return gate.verify_candidate(self.c.record, self.data)

    def test_valid_index(self):
        self.assertEqual(self.verify()['manifest_digest'], self.c.record['manifest_digest'])
        indexed = self.root / 'indexed'
        indexed.mkdir()
        candidate = Candidate(indexed, indexed=True)
        result = gate.verify_candidate(candidate.record, indexed)
        self.assertNotEqual(result['manifest_digest'], result['platform_manifest_digest'])
        self.assertNotEqual(result['platform_manifest_digest'], result['config_digest'])

    def test_native_provenance_rejections(self):
        def vcs(s): return s['predicate']['metadata']['https://mobyproject.org/buildkit@v1#metadata']['vcs']
        mutations = [lambda s: s.pop('predicate'),
                     lambda s: vcs(s).pop('source'), lambda s: vcs(s).pop('revision'),
                     lambda s: vcs(s).update(source='https://github.com/attacker/mindi'),
                     lambda s: vcs(s).update(revision='f'*40),
                     lambda s: vcs(s).update(revision='a'*40 + '-dirty'),
                     lambda s: s.update(predicateType='unknown'),
                     lambda s: s['subject'][0].update(digest={'sha256': 'f'*64})]
        for i, mutation in enumerate(mutations):
            with self.subTest(mutation=i):
                directory = self.root / str(i)
                directory.mkdir()
                c = Candidate(directory, mutate_statement=mutation)
                with self.assertRaises(ValueError): gate.verify_candidate(c.record, directory)

    def test_valid_slsa_v1(self):
        def upgrade(s):
            vcs = s['predicate']['metadata']['https://mobyproject.org/buildkit@v1#metadata']['vcs']
            s.update(_type='https://in-toto.io/Statement/v1', predicateType='https://slsa.dev/provenance/v1',
                     predicate={'buildDefinition': {'buildType': 'https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md'},
                                'runDetails': {'metadata': {'buildkit_metadata': {'vcs': vcs}}}})
        c = Candidate(self.data, mutate_statement=upgrade)
        self.assertEqual(gate.verify_candidate(c.record, self.data)['source_commit'], c.source)

    def test_unattested_single_manifest_refused(self):
        c = Candidate(self.data, indexed=False)
        with self.assertRaisesRegex(ValueError, 'indexed native provenance'):
            gate.verify_candidate(c.record, self.data)

    def test_upstream_revision_cannot_replace_standalone_label(self):
        c = Candidate(self.data, revision='e'*40)
        with self.assertRaisesRegex(ValueError, 'standalone OCI revision'):
            gate.verify_candidate(c.record, self.data)

    def test_exact_bundle_roundtrip(self):
        bundle = self.c.bundle(self.root / 'candidate.zip')
        self.assertEqual(gate.unpack_bundle(self.c.record, bundle, self.root / 'out')['source_commit'], self.c.source)

    def test_stale_future_or_overlong_record(self):
        for field, value in [('expires_at', '2000-01-01T00:00:00Z'), ('created_at', '2099-01-01T00:00:00Z'), ('expires_at', '2099-01-01T00:00:00Z')]:
            with self.subTest(field=field, value=value):
                record = copy.deepcopy(self.c.record)
                record[field] = value
                with self.assertRaises(ValueError): gate.validate_record(record)

    def test_untrusted_inputs_and_destinations(self):
        for field, value in [('version', 'latest'), ('version', 'v1.0.0;curl attacker'), ('source_commit', '$(id)'), ('version', '../v1.0.0'), ('destination', 'ghcr.io/other/image')]:
            with self.subTest(field=field):
                record = copy.deepcopy(self.c.record)
                record[field] = value
                with self.assertRaises(ValueError): gate.validate_record(record)

    def test_archive_mismatch(self):
        with (self.data / 'image.oci.tar').open('ab') as stream: stream.write(b'changed')
        with self.assertRaisesRegex(ValueError, 'archive digest'): self.verify()

    def test_config_id_is_not_manifest_digest(self):
        self.c.record['manifest_digest'] = self.c.manifest['config']['digest']
        self.c.record['index_digest'] = self.c.record['manifest_digest']
        with self.assertRaisesRegex(ValueError, 'manifest/index'): self.verify()

    def test_rehashed_archive_cannot_hide_modified_blob(self):
        path = self.data / 'image.oci.tar'
        content = path.read_bytes().replace(b'fixture layer only', b'changed layer only')
        path.write_bytes(content)
        self.c.record['archive_sha256'] = gate.digest_file(path)
        with self.assertRaisesRegex(ValueError, 'blob digest'): self.verify()

    def test_report_and_raw_digest_mismatch(self):
        for name in ['secrets.json', 'raw-evidence.json']:
            with self.subTest(name=name):
                path = self.data / name
                original = path.read_bytes()
                path.write_bytes(b'{} ')
                with self.assertRaises(ValueError): self.verify()
                path.write_bytes(original)

    def test_missing_evidence(self):
        del self.c.record['reports']['smoke']
        with self.assertRaisesRegex(ValueError, 'evidence'): self.verify()

    def test_semantic_rejections_even_when_report_hash_matches(self):
        mutations = [
            ('secrets', 'status', 'fail'), ('secrets', 'layers', {}), ('secrets', 'deleted_contents', False),
            ('secrets', 'content_scan', False), ('secrets', 'config_history', 'skipped'), ('secrets', 'findings', 1),
            ('secrets', 'errors', ['archive parse error']), ('secrets', 'manifest_digest', 'sha256:'+'0'*64),
            ('secrets', 'source_commit', '0'*40), ('secrets', 'observed_at', '2000-01-01T00:00:00Z'),
            ('vulnerabilities', 'unresolved', 1), ('vulnerabilities', 'errors', ['scan failed']),
            ('vulnerabilities', 'input', 'sbom'), ('vulnerabilities', 'archive_sha256', '0'*64),
            ('smoke', 'checks', {}), ('source', 'accepted_inputs_sha256', '0'*64),
            ('notices', 'disclosures', {}), ('provenance', 'build_without_package_write', False),
            ('review', 'reviewer', 'codi'), ('review', 'ci', 'failure')]
        original = copy.deepcopy(self.c.reports)
        for kind, field, value in mutations:
            with self.subTest(kind=kind, field=field):
                self.c.reports = copy.deepcopy(original)
                self.c.reports[kind][field] = value
                self.c.seal()
                with self.assertRaises(ValueError): self.verify()

    def test_mock_other_digest_and_failed_smoke_refused(self):
        original = copy.deepcopy(self.c.reports)
        for field, value in [('mode', 'mock'), ('status', 'skipped'), ('image_digest_tested', 'sha256:'+'0'*64)]:
            with self.subTest(field=field):
                self.c.reports = copy.deepcopy(original)
                self.c.reports['smoke']['checks']['second_box_credentials'][field] = value
                self.c.seal()
                with self.assertRaises(ValueError): self.verify()

    def test_unresolved_source_obligations(self):
        self.c.reports['notices']['corresponding_source']['components'][0]['status'] = 'missing'
        self.c.seal()
        with self.assertRaisesRegex(ValueError, 'obligations'): self.verify()

    def test_zip_traversal_and_duplicate_refused(self):
        for name in ['../escape', 'secrets.json']:
            with self.subTest(name=name):
                bundle = self.c.bundle(self.root / 'candidate.zip', (name, '{}'))
                with self.assertRaisesRegex(ValueError, 'bundle entries'): gate.unpack_bundle(self.c.record, bundle, self.root / ('out' + str(len(name))))

    def test_zip_symlink_refused(self):
        bundle = self.c.bundle(self.root / 'candidate.zip')
        # Rebuild one member as a symlink; names and checksums alone do not authorize links.
        with zipfile.ZipFile(bundle) as source:
            entries = [(i.filename, source.read(i)) for i in source.infolist()]
        with zipfile.ZipFile(bundle, 'w') as target:
            for name, data in entries:
                info = zipfile.ZipInfo(name)
                if name == 'image.oci.tar': info.external_attr = 0o120777 << 16
                target.writestr(info, data)
        self.c.record['bundle_sha256'] = gate.digest_file(bundle)
        with self.assertRaisesRegex(ValueError, 'links'): gate.unpack_bundle(self.c.record, bundle, self.root / 'out')

    def test_duplicate_json_keys_refused(self):
        path = self.root / 'duplicate.json'
        path.write_text('{"status":"fail","status":"pass"}')
        with self.assertRaises(ValueError): gate.read_json(path)

    def test_oci_symlink_and_attestation_mutation_refused(self):
        path = self.data / 'image.oci.tar'
        with tarfile.open(path, 'a') as archive:
            link = tarfile.TarInfo('escape')
            link.type = tarfile.SYMTYPE
            link.linkname = '/etc/passwd'
            archive.addfile(link)
        self.c.record['archive_sha256'] = gate.digest_file(path)
        with self.assertRaisesRegex(ValueError, 'OCI links'): self.verify()

    def test_old_database_refused(self):
        self.c.reports['vulnerabilities']['database']['updated_at'] = '2000-01-01T00:00:00Z'
        self.c.seal()
        with self.assertRaisesRegex(ValueError, 'stale vulnerability'): self.verify()


class TransportTests(unittest.TestCase):
    def test_existing_tag_is_collision(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
        with self.assertRaisesRegex(ValueError, 'already exists'):
            promote.assert_tag_absent('v1.2.3', 'fixture', lambda *a, **k: Response())

    def test_only_explicit_registry_404_allows_publication(self):
        for code, body, accepted in [(404, b'{"errors":[{"code":"MANIFEST_UNKNOWN","message":"manifest unknown"}]}', True),
                                      (404, b'{"errors":[{"code":"NAME_UNKNOWN","message":"repository name not known to registry"}]}', True),
                                      (401, b'{}', False), (403, b'{}', False), (429, b'{}', False),
                                      (500, b'{}', False), (404, b'{}', False)]:
            with self.subTest(code=code, body=body):
                def opener(*a, **k): raise urllib.error.HTTPError('https://ghcr.io', code, '', {}, io.BytesIO(body))
                if accepted: promote.assert_tag_absent('v1.2.3', 'fixture', opener)
                else:
                    with self.assertRaises(ValueError): promote.assert_tag_absent('v1.2.3', 'fixture', opener)

    def test_existing_index_and_negotiation_error_prevent_every_copy(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
        for negotiation_error in (False, True):
            with self.subTest(negotiation_error=negotiation_error), tempfile.TemporaryDirectory() as temp:
                path = Path(temp)
                c = Candidate(path)
                def opener(request, **kwargs):
                    self.assertIn('application/vnd.oci.image.index.v1+json', request.headers['Accept'])
                    self.assertIn('application/vnd.docker.distribution.manifest.list.v2+json', request.headers['Accept'])
                    if negotiation_error:
                        body = encoded({'errors': [{'code': 'MANIFEST_UNKNOWN', 'message': 'OCI index found, but Accept header does not support OCI indexes'}]})
                        raise urllib.error.HTTPError(request.full_url, 404, '', {}, io.BytesIO(body))
                    return Response()
                real_check = promote.assert_tag_absent
                with patch.object(promote, 'registry_token', return_value='fixture'), patch.object(promote, 'run') as run, patch.object(promote, 'assert_tag_absent', side_effect=lambda tag, token: real_check(tag, token, opener)):
                    with self.assertRaises(ValueError): promote.publish(c.record, path, path)
                    run.assert_not_called()

    def test_network_failure_is_not_absence(self):
        def opener(*a, **k): raise urllib.error.URLError('offline')
        with self.assertRaises(urllib.error.URLError): promote.assert_tag_absent('v1.2.3', 'fixture', opener)

    @patch.dict('os.environ', {'GITHUB_REPOSITORY': 'hexorx/mindi', 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REF': 'refs/heads/main', 'GITHUB_SHA': 'a'*40}, clear=True)
    def test_untrusted_ref_event_repo_and_stale_head(self):
        for key, value in [('GITHUB_REF', 'refs/pull/1/merge'), ('GITHUB_EVENT_NAME', 'pull_request_target'), ('GITHUB_REPOSITORY', 'attacker/mindi')]:
            with self.subTest(key=key), patch.dict('os.environ', {key: value}):
                with self.assertRaises(ValueError): promote.trusted_context()
        with patch.object(promote, 'github', return_value={'object': {'sha': 'b'*40}}):
            with self.assertRaisesRegex(ValueError, 'stale'): promote.trusted_context()

    def test_second_tag_collision_prevents_any_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            c = Candidate(path)
            with patch.object(promote, 'registry_token', return_value='fixture'), patch.object(promote, 'assert_tag_absent', side_effect=[None, ValueError('collision')]), patch.object(promote, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'collision'): promote.publish(c.record, path, path)
                run.assert_not_called()

    def test_failed_latest_exact_head_ci_refused(self):
        record = {'source_commit': 'a'*40, 'accepted_commit': 'b'*40}
        runs = [{'id': 1, 'name': 'check', 'app': {'slug': 'github-actions'}, 'head_sha': 'b'*40, 'status': 'completed', 'conclusion': 'success'},
                {'id': 2, 'name': 'check', 'app': {'slug': 'github-actions'}, 'head_sha': 'b'*40, 'status': 'completed', 'conclusion': 'failure'}]
        with patch.object(promote, 'github', return_value={'check_runs': runs}), patch.object(promote, 'run'):
            with self.assertRaisesRegex(ValueError, 'CI failed'): promote.check_source(record)

    def test_publish_uses_exact_archive_and_anonymous_full_pull(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            c = Candidate(path, indexed=True)
            commands = []
            def fake_run(args, **kwargs):
                commands.append(args)
                self.assertNotIn('GHCR_TOKEN', kwargs['env'])
                self.assertNotIn('GH_TOKEN', kwargs['env'])
                if args[1] == 'copy':
                    self.assertIn('--all', args)
                    self.assertIn('--preserve-digests', args)
                    Path(args[args.index('--digestfile') + 1]).write_text(c.record['manifest_digest'])
                if args[1] == 'inspect':
                    class Result: stdout = c.blobs['blobs/sha256/' + c.record['manifest_digest'][7:]]
                    return Result()
            with patch.dict('os.environ', {'GHCR_TOKEN': 'secret-fixture', 'GH_TOKEN': 'secret-fixture', 'GITHUB_ACTOR': 'fixture'}), patch.object(promote, 'registry_token', return_value='fixture'), patch.object(promote, 'assert_tag_absent'), patch.object(promote, 'run', side_effect=fake_run):
                result = promote.publish(c.record, path, path)
            self.assertEqual(result['anonymous_pull'], 'pass')
            self.assertEqual(len(result['published_tags']), 2)
            self.assertIn('oci-archive:' + str(path / 'image.oci.tar'), commands[0])
            self.assertIn('--src-no-creds', commands[2])
            self.assertIn('docker://' + gate.DESTINATION + '@' + c.record['manifest_digest'], commands[2])
            self.assertNotIn('secret-fixture', str(commands))
            self.assertEqual((path / 'auth.json').read_text(), '{}\n')

    def test_partial_failure_keeps_receipt_and_clears_credentials(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp)
            c = Candidate(path)
            with patch.dict('os.environ', {'GHCR_TOKEN': 'secret-fixture', 'GITHUB_ACTOR': 'fixture'}), patch.object(promote, 'registry_token', return_value='fixture'), patch.object(promote, 'assert_tag_absent'), patch.object(promote, 'run', side_effect=OSError('fixture transport failure')):
                with self.assertRaises(OSError): promote.publish(c.record, path, path)
            receipt = json.loads((path / 'receipt.json').read_text())
            self.assertEqual(receipt['published_tags'], [])
            self.assertEqual(len(receipt['attempted_tags']), 1)
            self.assertEqual(receipt['anonymous_pull'], 'not-run')
            self.assertEqual((path / 'auth.json').read_text(), '{}\n')


if __name__ == '__main__':
    unittest.main()
