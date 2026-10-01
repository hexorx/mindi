"""Fail closed on changed tokenizer bytes and keep cache settings in child env."""
import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT / 'runtime'))
import memory
spec = importlib.util.spec_from_file_location('bake_tokenizers', ROOT / 'build/bake_tokenizers.py')
bake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bake)


class TokenizerCacheTest(unittest.TestCase):
    def test_checksum_and_url_key_fail_closed(self):
        url = 'https://fixture.invalid/encoding'
        key = hashlib.sha1(url.encode()).hexdigest()
        entry = {'url': url, 'cache_key': key, 'sha256': hashlib.sha256(b'valid').hexdigest(), 'encoding': 'fixture'}
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / 'cache'
            with self.assertRaisesRegex(ValueError, 'checksum'):
                bake.install({'encodings': [entry]}, cache, lambda _: b'corrupted')
            self.assertFalse((cache / key).exists())
            bake.install({'encodings': [entry]}, cache, lambda _: b'valid')
            self.assertEqual((cache / key).read_bytes(), b'valid')
            self.assertEqual((cache / key).stat().st_mode & 0o777, 0o644)
            self.assertEqual(cache.stat().st_mode & 0o777, 0o755)
            with self.assertRaisesRegex(ValueError, 'cache key'):
                bake.install({'encodings': [{**entry, 'url': url + '/changed'}]}, cache, lambda _: b'valid')

    def test_child_environment_uses_image_cache_despite_caller_overrides(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in memory.SECRET_NAMES:
                (root / name).write_text('fixture')
            env = memory.environment({'TIKTOKEN_CACHE_DIR': '/empty-volume',
                                      'LITELLM_LOCAL_MODEL_COST_MAP': 'False'}, root)
            self.assertEqual(env['TIKTOKEN_CACHE_DIR'], '/opt/agent-box/tiktoken-cache')
            self.assertEqual(env['LITELLM_LOCAL_MODEL_COST_MAP'], 'True')
