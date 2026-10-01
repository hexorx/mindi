"""Cross-check the Hermes installed overlay against the complete upstream lock."""
from pathlib import Path
import re
import shlex
import tomllib
import unittest

BUILD = Path(__file__).parents[1] / 'build'


class SecurityPinsTest(unittest.TestCase):
    def test_installed_overlay_matches_lock_versions_and_artifact_hashes(self):
        lock = tomllib.loads((BUILD / 'hermes-uv.lock').read_text())
        packages = {p['name']: p for p in lock['package']}
        overlay = (BUILD / 'hermes-security.lock').read_text()
        for name, version in [('pyjwt', '2.14.0'), ('anyio', '4.14.2'),
                              ('httpx2', '2.12.0'), ('httpcore2', '2.12.0'),
                              ('urllib3', '2.8.0'), ('tornado', '6.5.9')]:
            self.assertEqual(packages[name]['version'], version)
            chunk = re.split(r'\n(?=[a-z])', overlay.split(name + '==' + version)[1])[0]
            hashes = re.findall(r'--hash=sha256:([a-f0-9]{64})', chunk)
            artifacts = packages[name]['wheels'] + [packages[name]['sdist']]
            self.assertTrue(hashes)
            for digest in hashes:
                self.assertIn('sha256:' + digest, {a['hash'] for a in artifacts})
        project = tomllib.loads((BUILD / 'hermes-pyproject.toml').read_text())
        self.assertIn('PyJWT[crypto]==2.14.0', project['project']['dependencies'])
        self.assertIn('urllib3==2.8.0', project['project']['dependencies'])
        self.assertIn('tornado==6.5.9', project['tool']['uv']['override-dependencies'])
        self.assertEqual(project['tool']['uv']['exclude-newer'], '2026-09-16T12:10:52Z')

    def test_overlay_installs_ignore_inherited_project_config(self):
        dockerfile = (BUILD.parent / 'Dockerfile').read_text()
        commands = [shlex.split(line.rstrip(' \\'))
                    for line in dockerfile.splitlines() if 'uv pip install ' in line]
        self.assertEqual(len(commands), 3)
        for command in commands:
            with self.subTest(command=command):
                self.assertIn('--no-config', command)
                self.assertIn('--no-deps', command)
                self.assertEqual(command[command.index('--python') + 1],
                                 '/opt/hermes/.venv/bin/python')
                if '-r' in command:
                    self.assertIn('--require-hashes', command)
                    self.assertIn('--only-binary=:all:', command)
                else:
                    self.assertIn('--no-index', command)
                    self.assertIn('/opt/build/hermes-wheel/*.whl', command)
        self.assertEqual({command[command.index('-r') + 1]
                          for command in commands if '-r' in command},
                         {'/opt/build/hermes-security.lock',
                          '/opt/build/hermes-build-tools.lock'})
        self.assertIn('(cd /opt/hermes && PYTHONPATH=/opt/build/hermes-build-tools '
                      '.venv/bin/python -c "from setuptools.build_meta import build_editable;',
                      dockerfile)

    def test_hindsight_compatible_fixed_versions_keep_cpu_torch(self):
        lock = (BUILD / 'hindsight-linux-amd64.lock').read_text()
        for pin in ['hindsight-api-slim==0.8.3', 'cryptography==50.0.2',
                    'transformers==5.15.1', 'pg0-embedded==0.15.2',
                    'sentence-transformers==6.1.0', 'torch==2.8.0+cpu',
                    'setuptools==83.0.0']:
            self.assertIn('# ' + pin + '\n', lock)

    def test_hindsight_setuptools_uses_reviewed_build_tool_artifact(self):
        def artifact(name):
            return next(line for line in (BUILD / name).read_text().splitlines()
                        if line.startswith('setuptools @ '))
        self.assertEqual(artifact('hindsight-linux-amd64.lock'),
                         artifact('hermes-build-tools.lock'))
