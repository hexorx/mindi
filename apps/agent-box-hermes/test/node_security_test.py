"""Behavioral checks for fail-closed installed-tree replacement."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

BUILD = Path(__file__).parents[1] / 'build'
spec = importlib.util.spec_from_file_location('node_security', BUILD / 'apply_node_security.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def archive(extra=None):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as tar:
        files = {'package/package.json': json.dumps({'name': 'fixture', 'version': '2.0.0'}),
                 'package/index.js': 'fixed'}
        if extra:
            files[extra] = 'bad'
        for name, data in files.items():
            raw = data.encode()
            info = tarfile.TarInfo(name)
            info.size = len(raw)
            tar.addfile(info, io.BytesIO(raw))
    return buffer.getvalue()


class NodeSecurityTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / 'opt/hermes/node_modules/fixture'
        (self.target / 'node_modules/child').mkdir(parents=True)
        (self.target / 'package.json').write_text(json.dumps({'name': 'fixture', 'version': '1.0.0'}))
        (self.target / 'obsolete.js').write_text('vulnerable')
        (self.target / 'node_modules/child/keep').write_text('nested')
        self.raw = archive()
        self.entry = dict(name='fixture', version='2.0.0', dependencies={}, url='https://example.invalid/package',
                          sha256=hashlib.sha256(self.raw).hexdigest(), targets=[dict(
                              path='/opt/hermes/node_modules/fixture', expectedVersion='1.0.0')])

    def apply(self):
        module.apply(self.root, {'schemaVersion': 1, 'packages': [self.entry]}, lambda url: self.raw)

    def test_replaces_old_bytes_and_keeps_nested_dependencies(self):
        self.apply()
        self.assertFalse((self.target / 'obsolete.js').exists())
        self.assertEqual((self.target / 'index.js').read_text(), 'fixed')
        self.assertEqual((self.target / 'node_modules/child/keep').read_text(), 'nested')

    def test_bad_hash_does_not_mutate_tree(self):
        self.entry['sha256'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            self.apply()
        self.assertTrue((self.target / 'obsolete.js').exists())

    def test_wrong_inherited_version_fails_closed(self):
        self.entry['targets'][0]['expectedVersion'] = '9.0.0'
        with self.assertRaisesRegex(ValueError, 'inherited package mismatch'):
            self.apply()
        self.assertTrue((self.target / 'obsolete.js').exists())

    def test_traversal_or_bundled_dependencies_are_rejected(self):
        for name in ['package/../../escape', 'package/node_modules/child/index.js']:
            with self.subTest(name=name):
                self.raw = archive(name)
                self.entry['sha256'] = hashlib.sha256(self.raw).hexdigest()
                with self.assertRaisesRegex(ValueError, 'unsafe archive'):
                    self.apply()
                self.assertTrue((self.target / 'obsolete.js').exists())

    def test_symlink_target_rejected(self):
        link = self.root / 'opt/hermes/node_modules/link'
        link.symlink_to(self.target, target_is_directory=True)
        self.entry['targets'][0]['path'] = '/opt/hermes/node_modules/link'
        with self.assertRaisesRegex(ValueError, 'symlink'):
            self.apply()

    def test_later_bad_archive_leaves_all_targets_unchanged(self):
        bad = dict(self.entry, sha256='0' * 64)
        with self.assertRaisesRegex(ValueError, 'hash mismatch'):
            module.apply(self.root, {'schemaVersion': 1, 'packages': [self.entry, bad]}, lambda url: self.raw)
        self.assertTrue((self.target / 'obsolete.js').exists())

    def test_photon_grpc_targets_the_inherited_sidecar_and_matches_provenance(self):
        lock = json.loads((BUILD / 'hermes-node-security.json').read_text())
        grpc, = [entry for entry in lock['packages'] if entry['name'] == '@grpc/grpc-js']
        self.assertEqual(grpc['version'], '1.14.5')
        self.assertEqual(grpc['targets'], [{
            'path': '/opt/hermes/plugins/platforms/photon/sidecar/node_modules/@grpc/grpc-js',
            'expectedVersion': '1.14.4',
        }])
        provenance = BUILD.parents[2] / 'docs/third-party/hex290-security-inputs'
        registry = json.loads((provenance / 'grpc-js-1.14.5-registry.json').read_text())
        self.assertEqual(grpc['dependencies'], registry['dependencies'])
        self.assertEqual(grpc['url'], registry['dist']['tarball'])
        records = json.loads((provenance / 'sources.json').read_text())
        for record in records:
            self.assertEqual(hashlib.sha256((provenance / record['file']).read_bytes()).hexdigest(),
                             record['sha256'])
        license_record, = [r for r in records if r['file'] == 'grpc-js-1.14.5-LICENSE']
        self.assertEqual(grpc['sha256'], license_record['archiveSha256'])

    def test_all_28_original_finding_paths_are_accounted_for(self):
        root = BUILD.parents[2]
        ledger = json.loads((root / 'docs/security-hex232-rows.json').read_text())['rows']
        historical = (root / 'docs/security-candidate-hex214.md').read_text().splitlines()
        original = set()
        for line in historical:
            if 'Inherited unchanged from pinned Hermes base' in line:
                fields = [value.strip() for value in line.split('|')[1:-1]]
                original.add((fields[1], fields[2], fields[3].strip('`')))
        self.assertEqual(len(original), 28)
        self.assertEqual(len(ledger), 28)
        self.assertEqual(original, {(r['advisory'], r['package'] + ' ' + r['oldVersion'], r['path']) for r in ledger})
        lock = json.loads((BUILD / 'hermes-node-security.json').read_text())
        targets = {t['path'] + '/package.json': (p['name'], p['version'])
                   for p in lock['packages'] for t in p['targets']}
        for row in ledger:
            if row['path'].endswith('/package.json'):
                self.assertEqual(targets[row['path']], (row['package'], row['targetVersion']))
