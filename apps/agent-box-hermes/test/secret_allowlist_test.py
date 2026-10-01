"""Synthetic native findings only; no credential values or provider calls."""
import copy
import bz2
import lzma
import io
import gzip
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from promotion_test import Candidate, encoded, gate, sha


def layer_bytes(files):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as archive:
        for name, data in files.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    return stream.getvalue()


class SecretAllowlistTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.c = Candidate(self.root, layer_data=layer_bytes({'opt/sample': b'public fixture\n'}))
        self.digest = self.c.manifest['layers'][0]['digest']
        self.report = self.c.reports['secrets']
        self.entry = dict(layer_digest=self.digest, path='/opt/sample', file_sha256=sha(b'public fixture\n'),
                          rule_id='generic-api-key', lines=[1], count=1, reason='Synthetic public fixture')
        self.allowlist = self.root / 'allowlist.json'
        self.mock = patch.object(gate, 'SECRET_ALLOWLIST', self.allowlist)
        self.mock.start()
        self.addCleanup(self.mock.stop)
        self.write_entries([self.entry])
        self.native = {digest: [] for digest in self.report['layers']}
        self.native[self.digest] = [dict(File='/opt/sample', RuleID='generic-api-key', StartLine=1)]
        self.rootfs = copy.deepcopy(self.native[self.digest])
        self.metadata = []
        self.seal()

    def write_entries(self, entries):
        self.allowlist.write_bytes(encoded({'schema_version': 1, 'entries': entries}))

    def seal(self):
        native = {'layers': {}, 'rootfs': 'raw-rootfs.json', 'metadata': 'raw-metadata.json'}
        payloads = {'raw-rootfs.json': self.rootfs, 'raw-metadata.json': self.metadata}
        for index, (digest, rows) in enumerate(self.native.items()):
            name = 'raw-layer-' + str(index) + '.json'
            native['layers'][digest] = name
            payloads[name] = rows
        for name, rows in payloads.items():
            data = encoded(rows)
            (self.root / name).write_bytes(data)
            self.c.record['attachments'][name] = sha(data)
        total = sum(map(len, payloads.values()))
        self.report.update(native=native, raw=list(payloads), findings=total, allowlisted=total, unresolved=0)
        self.c.seal()

    def verify(self):
        return gate.verify_candidate(self.c.record, self.root)

    def test_exact_native_match_passes(self):
        self.verify()

    def whole_file(self):
        self.entry.update(rule_id='pkcs12-file', lines=[0])
        self.write_entries([self.entry])
        self.native[self.digest] = [dict(File='/opt/sample', RuleID='pkcs12-file',
                                        StartLine=0, EndLine=0, StartColumn=0, EndColumn=0)]
        self.rootfs = copy.deepcopy(self.native[self.digest])
        self.seal()

    def test_whole_file_exact_pin_passes(self):
        self.whole_file()
        self.verify()

    def test_whole_file_unpinned_fails(self):
        self.whole_file()
        self.write_entries([])
        with self.assertRaisesRegex(ValueError, 'unmatched finding'):
            self.verify()

    def test_whole_file_pin_mutations_fail(self):
        self.whole_file()
        for field, value in [('file_sha256', sha(b'changed')), ('layer_digest', 'sha256:' + 'f'*64),
                             ('path', '/other'), ('rule_id', 'other'), ('lines', [1]), ('count', 2)]:
            with self.subTest(field=field):
                self.write_entries([{**self.entry, field: value}])
                with self.assertRaises(ValueError):
                    self.verify()

    def test_whole_file_invalid_coordinates_fail(self):
        self.whole_file()
        for surface in [self.native[self.digest], self.rootfs]:
            original = dict(surface[0])
            for field in ['StartLine', 'EndLine', 'StartColumn', 'EndColumn']:
                for value in [-1, 1, True, '0', None]:
                    if field == 'StartLine' and value == 1:
                        continue  # A positive start line remains a text finding.
                    with self.subTest(surface=surface, field=field, value=value):
                        surface[0] = {**original, field: value}
                        self.seal()
                        with self.assertRaisesRegex(ValueError, 'finding location'):
                            self.verify()
                surface[0] = dict(original)
                del surface[0][field]
                self.seal()
                with self.assertRaisesRegex(ValueError, 'finding location'):
                    self.verify()
                surface[0] = dict(original)

    def test_whole_file_mixed_or_invalid_allowlist_lines_fail(self):
        self.whole_file()
        for lines in [[0, 1], [1, 0], [0, 0], [-1], [False], ['0'], []]:
            with self.subTest(lines=lines):
                self.write_entries([{**self.entry, 'lines': lines, 'count': 2}])
                with self.assertRaises(ValueError):
                    self.verify()

    def test_pin_mutations_fail(self):
        for field, value in [('file_sha256', sha(b'changed bytes')), ('layer_digest', 'sha256:' + 'f'*64),
                             ('rule_id', 'different-rule'), ('path', '/opt/*'), ('reason', '  '),
                             ('lines', [2]), ('count', 2), ('lines', [1, 1]), ('count', True)]:
            with self.subTest(field=field, value=value):
                entry = {**self.entry, field: value}
                self.write_entries([entry])
                with self.assertRaises(ValueError):
                    self.verify()

    def test_changed_file_bytes_fail_with_fresh_oci_digest(self):
        changed = self.root / 'changed'
        changed.mkdir()
        candidate = Candidate(changed, layer_data=layer_bytes({'opt/sample': b'changed\n'}))
        # Update all layer identity references; retain the reviewed original file hash.
        previous_digest = self.digest
        new_digest = candidate.manifest['layers'][0]['digest']
        self.c, self.root = candidate, changed
        self.report = candidate.reports['secrets']
        self.native = {digest: [] for digest in self.report['layers']}
        self.native[new_digest] = copy.deepcopy(self.rootfs)
        self.write_entries([{**self.entry, 'layer_digest': new_digest}])
        self.assertNotEqual(previous_digest, new_digest)
        self.seal()
        with self.assertRaisesRegex(ValueError, 'file hash'):
            self.verify()

    def test_extra_finding_and_duplicate_occurrence_fail(self):
        for line in [1, 2]:
            with self.subTest(line=line):
                self.native[self.digest].append({**self.rootfs[0], 'StartLine': line})
                self.seal()
                with self.assertRaises(ValueError):
                    self.verify()
                self.native[self.digest].pop()

    def test_unused_entry_fails(self):
        self.write_entries([self.entry, {**self.entry, 'path': '/unused'}])
        with self.assertRaises(ValueError):
            self.verify()

    def test_missing_fields_and_duplicate_json_keys_fail(self):
        for field in self.entry:
            entry = dict(self.entry)
            del entry[field]
            self.write_entries([entry])
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.verify()
        self.allowlist.write_text('{"schema_version":1,"entries":[],"entries":[]}')
        with self.assertRaisesRegex(ValueError, 'duplicate JSON key'):
            self.verify()
        self.write_entries([self.entry, self.entry])
        with self.assertRaisesRegex(ValueError, 'duplicate allowlist entry'):
            self.verify()

    def test_metadata_and_attestation_findings_never_allowed(self):
        self.metadata = copy.deepcopy(self.rootfs)
        self.seal()
        with self.assertRaisesRegex(ValueError, 'metadata'):
            self.verify()
        self.metadata = []
        attestation = next(d for d in self.native if d != self.digest)
        self.native[attestation] = copy.deepcopy(self.rootfs)
        self.seal()
        with self.assertRaisesRegex(ValueError, 'metadata'):
            self.verify()

    def test_rootfs_extra_missing_or_different_finding_fails(self):
        for rows in [[], [dict(File='/missing', RuleID='generic-api-key', StartLine=1)],
                     [dict(File='/opt/sample', RuleID='other', StartLine=1)]]:
            self.rootfs = rows
            self.seal()
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                self.verify()

    def test_zero_native_and_legacy_reports_pass_only_without_entries(self):
        self.native = {digest: [] for digest in self.native}
        self.rootfs = []
        self.seal()
        with self.assertRaisesRegex(ValueError, 'unused'):
            self.verify()
        self.write_entries([])
        self.verify()
        del self.report['native']
        self.c.seal()
        self.verify()

    def test_counts_coverage_and_native_schema_fail_closed(self):
        for mutation in [lambda: self.report.update(findings=0), lambda: self.report.update(allowlisted=0),
                         lambda: self.report.update(unresolved=1), lambda: self.report.pop('allowlisted'),
                         lambda: self.report['native']['layers'].pop(self.digest),
                         lambda: self.report['native'].update(metadata='raw-rootfs.json')]:
            self.seal()
            mutation()
            self.c.seal()
            with self.assertRaises(ValueError):
                self.verify()

    def test_literal_glob_filename_and_gzip_layer_pass(self):
        directory = self.root / 'literal'
        directory.mkdir()
        self.c = Candidate(directory, layer_data=gzip.compress(layer_bytes({'opt/*': b'public fixture\n'})),
                           layer_media='application/vnd.oci.image.layer.v1.tar+gzip')
        self.root = directory
        self.report = self.c.reports['secrets']
        self.digest = self.c.manifest['layers'][0]['digest']
        self.native = {digest: [] for digest in self.report['layers']}
        self.native[self.digest] = [dict(File='/opt/*', RuleID='generic-api-key', StartLine=1)]
        self.rootfs = copy.deepcopy(self.native[self.digest])
        self.write_entries([{**self.entry, 'path': '/opt/*', 'layer_digest': self.digest}])
        self.seal()
        self.verify()

    def test_unsupported_and_mislabeled_layer_encodings_fail(self):
        plain = layer_bytes({'opt/sample': b'public fixture\n'})
        tar_media = 'application/vnd.oci.image.layer.v1.tar'
        cases = [
            (bz2.compress(plain), tar_media),
            (lzma.compress(plain), tar_media),
            (gzip.compress(plain), tar_media),
            (plain, tar_media + '+gzip'),
            (bz2.compress(plain), tar_media + '+gzip'),
            (lzma.compress(plain), tar_media + '+gzip'),
            (plain, tar_media + '+zstd'),
        ]
        base = self.root
        for index, (data, media) in enumerate(cases):
            with self.subTest(media=media, case=index):
                directory = base / ('encoding-' + str(index))
                directory.mkdir()
                self.c = Candidate(directory, layer_data=data, layer_media=media)
                self.root = directory
                self.report = self.c.reports['secrets']
                self.digest = self.c.manifest['layers'][0]['digest']
                self.native = {digest: [] for digest in self.report['layers']}
                self.native[self.digest] = copy.deepcopy(self.rootfs)
                self.write_entries([{**self.entry, 'layer_digest': self.digest}])
                self.seal()
                with self.assertRaisesRegex(ValueError, 'layer (encoding|compression)'):
                    self.verify()

    def test_symlink_cannot_be_allowlisted(self):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            member = tarfile.TarInfo('opt/sample')
            member.type, member.linkname = tarfile.SYMTYPE, '/outside'
            archive.addfile(member)
        directory = self.root / 'symlink'
        directory.mkdir()
        self.c = Candidate(directory, layer_data=stream.getvalue())
        self.root = directory
        self.report = self.c.reports['secrets']
        self.digest = self.c.manifest['layers'][0]['digest']
        self.native = {digest: [] for digest in self.report['layers']}
        self.native[self.digest] = copy.deepcopy(self.rootfs)
        self.write_entries([{**self.entry, 'layer_digest': self.digest}])
        self.seal()
        with self.assertRaisesRegex(ValueError, 'file hash'):
            self.verify()


class LayerOwnershipTests(unittest.TestCase):
    def verify_layers(self, files):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'image.oci.tar'
            layers = []
            with tarfile.open(path, 'w') as archive:
                for mapping in files:
                    data = layer_bytes(mapping)
                    digest = 'sha256:' + sha(data)
                    layers.append({'digest': digest, 'mediaType': 'application/vnd.oci.image.layer.v1.tar'})
                    member = tarfile.TarInfo('blobs/sha256/' + digest[7:])
                    member.size = len(data)
                    archive.addfile(member, io.BytesIO(data))
            hashes, visible = gate.secret_layer_files(path, layers, {'/opt/sample'})
            return layers, hashes, visible

    def test_topmost_provider_and_layer_bytes(self):
        layers, hashes, visible = self.verify_layers([{'opt/sample': b'old'}, {'opt/sample': b'new'}])
        self.assertEqual(visible['/opt/sample'], layers[1]['digest'])
        self.assertEqual(hashes[(layers[0]['digest'], '/opt/sample')], sha(b'old'))
        self.assertEqual(hashes[(layers[1]['digest'], '/opt/sample')], sha(b'new'))

    def test_whiteouts_opaque_directories_and_replacement(self):
        for upper in [{'opt/.wh.sample': b''}, {'opt/.wh..wh..opq': b''}, {'opt': b'replacement'}]:
            with self.subTest(upper=upper):
                _, _, visible = self.verify_layers([{'opt/sample': b'old'}, upper])
                self.assertNotIn('/opt/sample', visible)
        layers, _, visible = self.verify_layers([{'opt/sample': b'old'}, {'opt/sample': b'new', 'opt/.wh..wh..opq': b''}])
        self.assertEqual(visible['/opt/sample'], layers[1]['digest'])

    def test_unsafe_member_fails(self):
        with self.assertRaises(ValueError):
            self.verify_layers([{'../opt/sample': b'bad'}])

    def test_dockerfile_removes_keys_immediately_after_install(self):
        root = Path(__file__).resolve().parents[3]
        dockerfile = (root / 'apps/agent-box-hermes/Dockerfile').read_text()
        installation = dockerfile.split('/opt/build/apt/apt-install-locked.sh', 1)[1]
        self.assertTrue(installation.lstrip(' \\\n').startswith('&& rm -f /etc/chromium.d/apikeys'))
        self.assertIn('test ! -e /etc/chromium.d/apikeys && test ! -L /etc/chromium.d/apikeys', installation)
        self.assertIn('COPY --from=assembled / /', dockerfile)


if __name__ == '__main__':
    unittest.main()
