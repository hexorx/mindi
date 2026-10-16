"""Subscription bootstrap must never need, create, or expose provider API keys."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

APP = Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location('inference', APP / 'runtime/inference.py')
inference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inference)


class InferenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / '.hermes'
        patch.object(inference.os, 'chown').start()
        patch.object(inference.os, 'fchown').start()
        self.addCleanup(patch.stopall)

    def test_no_keys_needed_on_first_boot_or_restart(self):
        inference.seed(self.home, {})
        path = self.home / 'config.yaml'
        config = json.loads(path.read_text())
        self.assertEqual(config['model']['provider'], 'openai-codex')
        self.assertEqual(config['model']['base_url'], 'https://chatgpt.com/backend-api/codex')
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.home.stat().st_mode & 0o777, 0o700)
        auth = self.home / 'auth.json'
        auth.write_text('operator subscription state')
        inference.seed(self.home, {})
        self.assertEqual(json.loads(path.read_text()), config)
        self.assertEqual(auth.read_text(), 'operator subscription state')
        self.assertFalse((self.home / '.env').exists())

    def test_config_activation_and_file_memory_survive_restart(self):
        import sys
        with patch.object(sys, 'path', [str(APP / 'runtime'), *sys.path]):
            import config_sources
            import memory
        inference.seed(self.home, {})
        for _ in range(2):
            config_sources.apply(self.home, defaults=APP / 'defaults')
            memory.configure_builtin(self.home)
            inference.seed(self.home, {})
        config = json.loads((self.home / 'config.yaml').read_text())
        self.assertEqual(config['model']['provider'], 'openai-codex')
        self.assertEqual(config['memory']['provider'], '')
        self.assertTrue((self.home / 'memories').is_dir())
        self.assertFalse((self.home / 'hindsight').exists())

    def test_reject_paid_provider_or_custom_endpoint_without_echoing_values(self):
        for env in ({'HERMES_INFERENCE_PROVIDER': 'openai'},
                    {'HERMES_INFERENCE_PROVIDER': 'zai'},
                    {'HERMES_INFERENCE_BASE_URL': 'https://private.invalid'},
                    {'HERMES_INFERENCE_MODEL': 'bad\nvalue'}):
            with self.assertRaises(ValueError) as error:
                inference.seed(self.home, env)
            self.assertIn('values redacted', str(error.exception))
            self.assertFalse(self.home.exists())

    def test_preserves_operator_files_and_rejects_unmanaged_links(self):
        self.home.mkdir()
        path = self.home / 'config.yaml'
        path.write_text('{"model":"operator"}')
        inference.seed(self.home, {})
        self.assertEqual(path.read_text(), '{"model":"operator"}')
        path.unlink()
        path.symlink_to('/outside')
        with self.assertRaises(ValueError):
            inference.seed(self.home, {})

    def test_bootstrap_does_not_prepare_paid_memory_secrets(self):
        source = (APP / 'runtime/bootstrap.py').read_text()
        self.assertNotIn('"prepare"', source)
        self.assertNotIn('API_KEY', source)
        for name in ('compose.yaml', 'compose.p7.yaml'):
            source = (APP.parents[1] / 'stacks/agent-box-hermes' / name).read_text()
            self.assertNotIn('KEY_FILE', source.replace('DESKTOP_TLS_KEY_FILE', ''))


if __name__ == '__main__':
    unittest.main()
