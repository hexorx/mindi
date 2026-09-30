"""Cross-check the Hermes installed overlay against the complete upstream lock."""
from pathlib import Path
import re
import tomllib
import unittest

BUILD = Path(__file__).parents[1] / 'build'


class SecurityPinsTest(unittest.TestCase):
    def test_installed_overlay_matches_lock_versions_and_artifact_hashes(self):
        lock = tomllib.loads((BUILD / 'hermes-uv.lock').read_text())
        packages = {p['name']: p for p in lock['package']}
        overlay = (BUILD / 'hermes-security.lock').read_text()
        for name, version in [('pyjwt', '2.14.0'), ('anyio', '4.14.2')]:
            self.assertEqual(packages[name]['version'], version)
            chunk = overlay.split(name + '==' + version)[1].split('\n\n')[0]
            hashes = re.findall(r'--hash=sha256:([a-f0-9]{64})', chunk)
            artifacts = packages[name]['wheels'] + [packages[name]['sdist']]
            self.assertTrue(hashes)
            for digest in hashes[:2]:
                self.assertIn('sha256:' + digest, {a['hash'] for a in artifacts})
        project = tomllib.loads((BUILD / 'hermes-pyproject.toml').read_text())
        self.assertIn('PyJWT[crypto]==2.14.0', project['project']['dependencies'])
        self.assertEqual(project['tool']['uv']['exclude-newer'], '2026-09-16T12:10:52Z')

    def test_hindsight_compatible_fixed_versions_keep_cpu_torch(self):
        lock = (BUILD / 'hindsight-linux-amd64.lock').read_text()
        for pin in ['hindsight-api-slim==0.8.3', 'cryptography==50.0.2',
                    'transformers==5.15.1', 'pg0-embedded==0.15.2',
                    'sentence-transformers==6.1.0', 'torch==2.8.0+cpu']:
            self.assertIn('# ' + pin + '\n', lock)
