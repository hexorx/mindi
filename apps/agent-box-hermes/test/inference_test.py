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
ENV = {'HERMES_INFERENCE_PROVIDER': 'zai', 'HERMES_INFERENCE_MODEL': 'glm-5.3-flash',
       'HERMES_INFERENCE_BASE_URL': 'https://api.z.ai/api/coding/paas/v4'}


class InferenceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / '.hermes'
        self.key = Path(self.tmp.name) / 'key'
        self.key.write_text('fixture-only-key\n')
        self.chown = patch.object(inference.os, 'chown').start()
        self.fchown = patch.object(inference.os, 'fchown').start()
        self.addCleanup(patch.stopall)

    def seed(self, env=None):
        inference.seed(self.home, ENV if env is None else env, self.key)

    def test_fresh_boot_activation_and_restart_preserve_inference(self):
        import sys
        with patch.object(sys, 'path', [str(APP / 'runtime'), *sys.path]):
            import config_sources
        self.seed()
        self.assertEqual((self.home / '.env').read_text(),
                         'GLM_API_KEY=fixture-only-key\nGLM_BASE_URL=' + ENV['HERMES_INFERENCE_BASE_URL'] + '\n')
        expected = {'provider': 'zai', 'default': 'glm-5.3-flash',
                    'base_url': ENV['HERMES_INFERENCE_BASE_URL']}
        for name in ('.env', 'config.yaml'):
            self.assertEqual((self.home / name).stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.home.stat().st_mode & 0o777, 0o700)
        self.chown.assert_called_with(self.home, 1000, 1000)
        self.assertEqual(self.fchown.call_count, 2)
        self.assertTrue(all(call.args[1:] == (1000, 1000) for call in self.fchown.call_args_list))
        config_sources.apply(self.home, defaults=APP / 'defaults')
        self.key.unlink()
        self.seed({**ENV, 'HERMES_INFERENCE_MODEL': 'changed'})
        config_sources.apply(self.home, defaults=APP / 'defaults')
        self.assertTrue((self.home / 'config.yaml').is_symlink())
        self.assertEqual(json.loads((self.home / 'config.yaml').read_text())['model'], expected)
        self.assertIn('fixture-only-key', (self.home / '.env').read_text())

    def test_existing_operator_files_are_unchanged(self):
        self.home.mkdir()
        (self.home / '.env').write_text('operator-env')
        (self.home / 'config.yaml').write_text('{"model":"operator"}')
        self.key.unlink()
        self.seed()
        self.assertEqual((self.home / '.env').read_text(), 'operator-env')
        self.assertEqual((self.home / 'config.yaml').read_text(), '{"model":"operator"}')

    def test_disabled_and_invalid_inputs(self):
        self.seed({})
        self.assertFalse(self.home.exists())
        for env in ({'HERMES_INFERENCE_PROVIDER': 'zai'},
                    {**ENV, 'HERMES_INFERENCE_PROVIDER': 'openai'},
                    {**ENV, 'HERMES_INFERENCE_BASE_URL': 'https://user:secret@example.com'},
                    {**ENV, 'HERMES_INFERENCE_BASE_URL': 'https://example.com/\nEVIL=value'}):
            with self.assertRaises(ValueError):
                self.seed(env)
        self.assertFalse(self.home.exists())
        for key in ('', 'fixture-secret\nEVIL=value', 'fixture-${TOKEN}', 'x' * 8193):
            self.key.write_text(key)
            with self.assertRaisesRegex(ValueError, 'values redacted') as error:
                self.seed()
            if key:
                self.assertNotIn(key, str(error.exception))
            self.assertFalse((self.home / '.env').exists())
            self.assertFalse((self.home / 'config.yaml').exists())

    def test_symlinks_rejected_without_modifying_target(self):
        self.home.symlink_to(Path(self.tmp.name), target_is_directory=True)
        with self.assertRaises(ValueError):
            self.seed()
        self.home.unlink()
        self.home.mkdir()
        (self.home / '.env').symlink_to(self.key)
        with self.assertRaises(ValueError):
            self.seed()
        self.assertEqual(self.key.read_text(), 'fixture-only-key\n')

    def test_failed_publication_is_retryable_and_cleans_private_temporary(self):
        with patch.object(inference.os, 'link', side_effect=OSError('fixture disk failure')):
            with self.assertRaises(OSError):
                self.seed()
        self.assertEqual(list(self.home.iterdir()), [])
        self.seed()
        self.assertTrue((self.home / '.env').exists())


if __name__ == '__main__':
    unittest.main()
