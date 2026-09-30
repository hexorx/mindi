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
