import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).parents[1] / 'runtime'))
import memory
import config_sources


class MemoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home/.hermes'
        self.home.mkdir(parents=True)
        (self.home / 'config.yaml').write_text('{"model":"preserve"}')
        self.data = self.root / 'data'
        self.data.mkdir()

    def test_identity_and_configuration_survive_restart(self):
        memory.configure(self.home, self.data)
        first = (self.home / 'hindsight/config.json').read_bytes()
        memory.configure(self.home, self.data)
        self.assertEqual(first, (self.home / 'hindsight/config.json').read_bytes())
        cfg = json.loads(first)
        self.assertTrue(cfg['bank_id'].startswith('box-'))
        self.assertEqual(cfg['mode'], 'local_external')
        self.assertEqual(json.loads((self.home / 'config.yaml').read_text())['model'], 'preserve')
        other = self.root / 'other/.hermes'
        other.mkdir(parents=True)
        (other / 'config.yaml').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'different box'):
            memory.configure(other, self.data)

    def test_managed_configuration_survives_memory_boot_and_refresh(self):
        defaults = Path(__file__).parents[1] / 'defaults'
        config_sources.apply(self.home, defaults=defaults)
        config_path = self.home / 'config.yaml'
        target = os.readlink(config_path)
        memory.configure(self.home, self.data)
        bank = (self.home / 'hindsight/config.json').read_bytes()
        config_sources.apply(self.home, defaults=defaults, refresh=True)
        memory.configure(self.home, self.data)
        self.assertEqual(os.readlink(config_path), target)
        self.assertEqual(json.loads(config_path.read_text())['memory']['provider'], 'hindsight')
        self.assertEqual(json.loads(config_path.read_text())['model'], 'preserve')
        self.assertEqual((self.home / 'hindsight/config.json').read_bytes(), bank)

    def test_zai_operator_model_and_dotenv_survive_config_activation(self):
        model = {'provider': 'zai', 'default': 'glm-5.3-flash',
                 'base_url': 'https://api.z.ai/api/coding/paas/v4'}
        (self.home / 'config.yaml').write_text(json.dumps({'model': model}))
        dotenv = 'GLM_API_KEY=fixture-key\nGLM_BASE_URL=https://api.z.ai/api/coding/paas/v4\n'
        (self.home / '.env').write_text(dotenv)
        for refresh in (False, True):
            config_sources.apply(self.home, defaults=Path(__file__).parents[1] / 'defaults', refresh=refresh)
            memory.configure(self.home, self.data)
            self.assertEqual(json.loads((self.home / 'config.yaml').read_text())['model'], model)
            self.assertEqual((self.home / '.env').read_text(), dotenv)

    def test_missing_or_invalid_key_has_redacted_diagnostic(self):
        for name in memory.SECRET_NAMES:
            with self.assertRaisesRegex(ValueError, 'missing runtime secret ' + name):
                memory.secret(self.root / name, name)
            (self.root / name).write_text('sensitive\nvalue')
            with self.assertRaises(ValueError) as error:
                memory.secret(self.root / name, name)
            self.assertNotIn('sensitive', str(error.exception))

    def test_environment_cannot_override_private_listener_or_database(self):
        for name in memory.SECRET_NAMES:
            (self.root / name).write_text('fixture-' + name)
        env = memory.environment({'HINDSIGHT_API_HOST': '0.0.0.0', 'HINDSIGHT_API_DATABASE_URL': 'remote',
                                  'UNRELATED_SECRET': 'never', 'MEMORY_LLM_PROVIDER': 'anthropic',
                                  'MEMORY_EMBEDDINGS_BASE_URL': 'http://127.0.0.1:9999/v1'}, self.root)
        self.assertEqual(env['HINDSIGHT_API_HOST'], '127.0.0.1')
        self.assertEqual(env['HINDSIGHT_API_DATABASE_URL'], 'pg0://hindsight')
        self.assertEqual(env['HOME'], str(memory.DATA))
        self.assertNotIn('UNRELATED_SECRET', env)
        self.assertNotEqual(env['HINDSIGHT_API_LLM_API_KEY'], env['HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY'])
        with self.assertRaisesRegex(ValueError, 'PROVIDER'):
            memory.environment({'MEMORY_LLM_PROVIDER': 'unknown'}, self.root)

    def test_empty_compose_values_keep_openai_defaults(self):
        for name in memory.SECRET_NAMES:
            (self.root / name).write_text('fixture-key')
        source = dict.fromkeys(('MEMORY_LLM_PROVIDER', 'MEMORY_LLM_MODEL', 'MEMORY_LLM_BASE_URL',
                                'MEMORY_EMBEDDINGS_PROVIDER', 'MEMORY_EMBEDDINGS_MODEL',
                                'MEMORY_EMBEDDINGS_BASE_URL'), '')
        env = memory.environment(source, self.root)
        self.assertEqual(env['HINDSIGHT_API_LLM_PROVIDER'], 'openai')
        self.assertEqual(env['HINDSIGHT_API_LLM_MODEL'], 'gpt-4o-mini')
        self.assertEqual(env['HINDSIGHT_API_EMBEDDINGS_PROVIDER'], 'openai')
        self.assertNotIn('HINDSIGHT_API_LLM_BASE_URL', env)
        self.assertNotIn('HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL', env)

    def test_local_embeddings_use_cpu_cache_without_remote_key_or_url(self):
        (self.root / 'memory_llm_key').write_text('fixture-zai-key')
        source = {'MEMORY_LLM_PROVIDER': 'openai', 'MEMORY_LLM_MODEL': 'glm-5.3-flash',
                  'MEMORY_LLM_BASE_URL': 'https://api.z.ai/api/coding/paas/v4',
                  'MEMORY_EMBEDDINGS_PROVIDER': 'local',
                  'MEMORY_EMBEDDINGS_BASE_URL': 'https://unused.example',
                  'HF_HOME': '/untrusted', 'HINDSIGHT_API_EMBEDDINGS_LOCAL_TRUST_REMOTE_CODE': 'true'}
        env = memory.environment(source, self.root)
        self.assertEqual(env['HINDSIGHT_API_LLM_BASE_URL'], source['MEMORY_LLM_BASE_URL'])
        self.assertEqual(env['HINDSIGHT_API_LLM_MODEL'], 'glm-5.3-flash')
        self.assertEqual(env['HINDSIGHT_API_EMBEDDINGS_PROVIDER'], 'local')
        self.assertEqual(env['HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL'], 'BAAI/bge-small-en-v1.5')
        self.assertEqual(env['HINDSIGHT_API_EMBEDDINGS_LOCAL_FORCE_CPU'], 'true')
        self.assertEqual(env['HINDSIGHT_API_EMBEDDINGS_LOCAL_TRUST_REMOTE_CODE'], 'false')
        self.assertEqual(env['HF_HOME'], str(memory.DATA / 'huggingface'))
        self.assertFalse(any(k.startswith('HINDSIGHT_API_EMBEDDINGS_OPENAI_') for k in env))
        env = memory.environment({**source, 'MEMORY_EMBEDDINGS_MODEL': 'custom/model'}, self.root)
        self.assertEqual(env['HINDSIGHT_API_EMBEDDINGS_LOCAL_MODEL'], 'custom/model')
        with self.assertRaisesRegex(ValueError, 'MEMORY_EMBEDDINGS_PROVIDER'):
            memory.environment({**source, 'MEMORY_EMBEDDINGS_PROVIDER': 'unknown'}, self.root)

    def test_secret_copy_is_private_and_never_persistent(self):
        source = self.root / 'secrets'
        source.mkdir()
        for name in memory.SECRET_NAMES:
            (source / name).write_text('fixture-key')
        runtime = self.root / 'run'
        with patch('os.chown'):
            memory.prepare(self.data, runtime, source)
        self.assertEqual(list(self.data.iterdir()), [])
        for name in memory.SECRET_NAMES:
            self.assertEqual((runtime / name).stat().st_mode & 0o777, 0o600)

    def test_symlink_targets_are_rejected(self):
        (self.data / 'box-id').symlink_to(self.root / 'outside')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            memory.configure(self.home, self.data)
        self.assertFalse((self.root / 'outside').exists())


if __name__ == '__main__': unittest.main()
