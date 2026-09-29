"""Regression coverage for the release's restricted Docker build context."""
import fnmatch
import json
from pathlib import Path
import shlex
import unittest

APP = Path(__file__).resolve().parents[1]
ROOT = APP.parents[1]


def included(path):
    # This allowlist uses only literal paths and ** patterns (no Docker classes).
    selected = True
    for rule in (APP / 'Dockerfile.dockerignore').read_text().splitlines():
        if not rule or rule.startswith('#'):
            continue
        allow = rule.startswith('!')
        if fnmatch.fnmatchcase(path, rule.lstrip('!')):
            selected = allow
    return selected


class ReleaseInputsTest(unittest.TestCase):
    def test_every_local_copy_has_all_of_its_tracked_inputs(self):
        for line in (APP / 'Dockerfile').read_text().splitlines():
            if not line.startswith('COPY ') or '--from=' in line:
                continue
            args = [arg for arg in shlex.split(line)[1:] if not arg.startswith('--')]
            for source in args[:-1]:
                path = ROOT / source
                self.assertTrue(path.exists(), source)
                files = [path] if path.is_file() else list(path.rglob('*'))
                for file in files:
                    if file.is_file() and '__pycache__' not in file.parts:
                        relative = file.relative_to(ROOT).as_posix()
                        self.assertTrue(included(relative), relative)

    def test_credentials_and_repository_state_are_excluded(self):
        for path in ['.env', '.git/config', 'docs/private.md',
                     'apps/agent-box-hermes/build/.env',
                     'apps/agent-box-hermes/runtime/.env.production',
                     'apps/agent-box-hermes/runtime/server.key',
                     'apps/agent-box-hermes/desktop/server.pem',
                     'apps/agent-box-hermes/runtime/__pycache__/example.pyc']:
            self.assertFalse(included(path), path)

    def test_source_grant_keeps_superseded_decision_and_scope(self):
        manifest = json.loads((ROOT / 'docs/extraction-allowlist.json').read_text())
        self.assertEqual(manifest['publicRedistribution'], 'authorized_under_mit')
        decision = manifest['redistributionDecision']
        self.assertEqual(decision['licenseGrant'], 'MIT')
        self.assertEqual(decision['supersedes']['decision'], 'Withhold redistribution authorization')
        self.assertEqual(manifest['defaultTreatment'], 'exclude')
        self.assertIn('COPY LICENSE /usr/share/doc/agent-box-hermes/LICENSE',
                      (APP / 'Dockerfile').read_text())
