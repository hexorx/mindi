"""Final membership must not be inferred from historical lock/SBOM rows."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[3] / 'scripts/release/reconcile_final_inventory.py'
spec = importlib.util.spec_from_file_location('reconcile_final_inventory', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FinalInventoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.docs = self.root / module.DOCS
        self.docs.mkdir(parents=True)
        self.text = self.docs / 'texts/license.txt'
        self.text.parent.mkdir()
        self.text.write_bytes(b'exact upstream bytes\r\n')
        self.rows = [
            {'kind': 'python', 'name': 'demo', 'version': '1', 'environment': '/python'},
            {'kind': 'debian', 'name': 'demo-deb', 'version': '2'},
            {'kind': 'cua-rust-lock-candidate', 'name': 'candidate', 'version': '1', 'membership': 'superset'},
            {'kind': 'sbom-npm', 'name': '@photon-ai/slack', 'version': '0.2.0',
             'locations': [{'path': '/node_modules/@photon-ai/slack/package.json'}]},
            {'kind': 'sbom-npm', 'name': 'playwright-core', 'version': '1.62.1',
             'locations': [{'path': '/root/.npm/_npx/old/node_modules/playwright-core/package.json'}]},
            {'kind': 'retained-cache', 'name': '/root/.npm', 'version': 'old'},
            {'kind': 'python', 'name': 'claude-agent-sdk', 'version': '1', 'environment': '/python'},
        ]
        for row in self.rows:
            row.update(source_status='not_reconciled', texts=['texts/license.txt'])
        self.write('reconciliation.json', {'rows': self.rows})
        self.write('manifest.json', {'notices': [{'file': 'texts/license.txt',
                    'sha256': hashlib.sha256(self.text.read_bytes()).hexdigest(), 'original_path': 'LICENSE'}]})
        self.write('hex195-provenance-join/prior-reconciliation/overlay.json', {'rows': [{} for _ in self.rows]})
        self.write('payload-remediation.json', {'excluded': ['@photon-ai/slack']})
        self.sbom = {'descriptor': {'name': 'syft', 'version': 'test'},
                     'source': {'type': 'directory', 'metadata': {}},
                     'artifacts': [{'id': 'relocated', 'type': 'npm', 'name': 'playwright-core', 'version': '1.62.1',
                                    'locations': [{'path': '/opt/agent-box/playwright-core/package.json'}]}]}
        self.inventory = {'python': {'executable': '/python', 'packages': [
            {'name': 'demo', 'version': '1', 'notices': []},
            {'name': 'claude-agent-sdk', 'version': '1', 'notices': []}]},
            'debian': [{'name': 'demo-deb', 'version': '2', 'notices': []}]}

    def write(self, name, content):
        path = self.docs / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(content))

    def run_join(self):
        return module.reconcile(self.root, self.sbom, [self.inventory], 'a' * 40, 'sha256:' + 'b' * 64)

    def test_membership_and_original_evidence_preserved(self):
        before = (self.docs / 'reconciliation.json').read_bytes()
        result = self.run_join()
        self.assertEqual([r['membership'] for r in result['baseline_rows']],
                         ['installed', 'installed', 'candidate-only', 'removed', 'relocated', 'removed', 'modified'])
        self.assertEqual((self.docs / 'reconciliation.json').read_bytes(), before)
        self.assertTrue(all(r['source_status'] == 'not_reconciled' for r in result['baseline_rows']))
        self.assertEqual(result['baseline_rows'][2]['prior_membership'], 'superset')
        self.assertFalse(result['complete'])

    def test_provider_in_final_sbom_is_rejected(self):
        self.sbom['artifacts'][0].update(name='@photon-ai/slack', version='0.2.0')
        with self.assertRaisesRegex(ValueError, 'excluded provider'):
            self.run_join()

    def lock_artifact(self, name='@photon-ai/slack'):
        return {'id': name, 'type': 'npm', 'name': name, 'version': '0.2.0',
                'foundBy': 'javascript-lock-cataloger',
                'metadataType': 'javascript-npm-package-lock-entry',
                'locations': [{'path': '/opt/hermes/plugins/platforms/photon/sidecar/package-lock.json'}]}

    def test_lock_only_exclusions_preserve_inputs_without_installed_join(self):
        for name in sorted(module.EXCLUDED):
            self.sbom['artifacts'].append(self.lock_artifact(name))
        lock = self.root / 'opt/hermes/plugins/platforms/photon/sidecar/package-lock.json'
        lock.parent.mkdir(parents=True)
        lock.write_text(json.dumps({'packages': {n: {} for n in module.EXCLUDED}}))
        before_lock, before_sbom = lock.read_bytes(), json.dumps(self.sbom, sort_keys=True)
        result = self.run_join()
        for row in result['final_sbom_rows'][1:]:
            self.assertEqual(row['membership'], 'lock-only')
            self.assertEqual(row['baseline_rows'], [])
            self.assertEqual(row['metadata_type'], 'javascript-npm-package-lock-entry')
            self.assertEqual(row['source_status'], 'not_reconciled')
        self.assertEqual(result['baseline_rows'][3]['membership'], 'removed')
        self.assertEqual(lock.read_bytes(), before_lock)
        self.assertEqual(json.dumps(self.sbom, sort_keys=True), before_sbom)
        self.assertFalse(result['complete'])

    def test_lock_record_does_not_hide_separate_installed_artifact(self):
        for reverse in (False, True):
            rows = [self.lock_artifact(), dict(self.lock_artifact(), id='installed',
                    foundBy='javascript-package-cataloger', metadataType='javascript-npm-package',
                    locations=[{'path': '/node_modules/@photon-ai/slack/package.json'}])]
            self.sbom['artifacts'] = rows[::-1] if reverse else rows
            with self.assertRaisesRegex(ValueError, 'excluded provider'):
                self.run_join()

    def test_mixed_lock_and_installed_locations_are_rejected(self):
        for field in ('path', 'accessPath'):
            row = self.lock_artifact()
            if field == 'path':
                row['locations'].append({'path': '/node_modules/@photon-ai/slack/package.json'})
            else:
                row['locations'][0][field] = '/node_modules/@photon-ai/slack/package.json'
            self.sbom['artifacts'] = [row]
            with self.assertRaisesRegex(ValueError, 'excluded provider'):
                self.run_join()

    def test_incomplete_lock_metadata_is_rejected(self):
        for field in ('foundBy', 'metadataType', 'locations'):
            self.sbom['artifacts'] = [self.lock_artifact()]
            self.sbom['artifacts'][0].pop(field)
            with self.assertRaisesRegex(ValueError, 'excluded provider'):
                self.run_join()

    def test_unexpected_actual_excluded_files_without_sbom_artifact(self):
        for name in sorted(module.EXCLUDED):
            with self.subTest(name=name):
                path = self.root / 'unexpected/node_modules' / name / 'dist/index.js'
                path.parent.mkdir(parents=True)
                path.write_text('actual excluded file')
                with self.assertRaisesRegex(ValueError, 'excluded provider file'):
                    self.run_join()
                path.unlink()
                path.parent.rmdir()
                path.parent.parent.rmdir()

    def test_lock_metadata_does_not_hide_actual_aliased_manifest(self):
        self.sbom['artifacts'] = [self.lock_artifact()]
        path = self.root / 'unexpected/alias/package.json'
        path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'name': '@photon-ai/slack', 'version': '0.2.0'}))
        with self.assertRaisesRegex(ValueError, 'excluded provider manifest'):
            self.run_join()

    def test_excluded_package_symlink_is_rejected(self):
        path = self.root / 'node_modules/@photon-ai/slack'
        path.parent.mkdir(parents=True)
        path.symlink_to('/missing', target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'excluded provider file'):
            self.run_join()

    def test_ordinary_lock_candidates_do_not_close_pending_membership(self):
        self.rows[4]['locations'] = [{'path': '/package-lock.json'}]
        self.write('reconciliation.json', {'rows': self.rows})
        (self.root / 'package-lock.json').write_text('{}')
        self.sbom['artifacts'] = [dict(self.lock_artifact('playwright-core'), version='1.62.1',
                                    locations=[{'path': '/package-lock.json'}])]
        result = self.run_join()
        self.assertEqual(result['baseline_rows'][4]['membership'], 'needs-membership-review')
        self.assertIn(4, result['pending_membership_rows'])
        self.assertEqual(result['baseline_rows'][4]['source_status'], 'not_reconciled')

    def test_all_layer_scan_and_missing_environment_are_rejected(self):
        self.sbom['source']['metadata']['scope'] = 'all-layers'
        with self.assertRaisesRegex(ValueError, 'final filesystem'):
            self.run_join()
        self.sbom['source']['metadata']['scope'] = 'squashed'
        self.inventory['python']['executable'] = '/different-python'
        with self.assertRaisesRegex(ValueError, 'missing Python environments'):
            self.run_join()

    def test_missing_or_changed_notice_cannot_silently_map(self):
        self.text.write_bytes(b'different bytes')
        with self.assertRaisesRegex(ValueError, 'changed historical notice'):
            self.run_join()

    def test_stale_version_is_not_installed(self):
        self.inventory['python']['packages'][0]['version'] = '2'
        self.assertEqual(self.run_join()['baseline_rows'][0]['membership'], 'absent-from-environment')

    def test_historical_metadata_is_not_distributed_component(self):
        row = self.sbom['artifacts'][0]
        row.update(name='@photon-ai/slack', version='0.2.0',
                   locations=[{'path': '/' + module.DOCS + '/historical/package.json'}])
        final = self.run_join()['final_sbom_rows'][0]
        self.assertEqual(final['membership'], 'historical-evidence-only')
        self.assertEqual(final['baseline_rows'], [])

    def test_exported_symlink_cannot_escape_to_host(self):
        (self.root / 'escape').symlink_to('/etc')
        with self.assertRaisesRegex(ValueError, 'escapes exported root'):
            module.inside(self.root, '/escape/passwd')


if __name__ == '__main__':
    unittest.main()
