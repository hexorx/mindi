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
                paths = list(ROOT.glob(source))
                self.assertTrue(paths, source)
                files = [file for path in paths
                         for file in ([path] if path.is_file() else path.rglob('*'))]
                for file in files:
                    if file.is_file() and '__pycache__' not in file.parts:
                        relative = file.relative_to(ROOT).as_posix()
                        self.assertTrue(included(relative), relative)

    def test_credentials_and_repository_state_are_excluded(self):
        for path in ['.env', '.git/config', 'docs/private.md',
                     'apps/agent-box-hermes/build/.env',
                     'docs/third-party/hex184-resolution/inputs.json',
                     'docs/third-party/hex184-resolution/bundle/private.pem',
                     'docs/third-party/hex184-resolution/bundle/texts/.env',
                     'apps/agent-box-hermes/build/apt-private.key',
                     'apps/agent-box-hermes/build/apt-private.pem',
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

    def test_accepted_residuals_stay_disclosed_and_separate_from_remediation(self):
        status = (ROOT / 'docs/third-party/NOTICE-STATUS.md').read_text()
        for component in ['Manylinux vendored libraries', 's6 musl toolchain',
                          'cua/pg0 linkage bounds', 'Native bindings and esbuild',
                          'TOFU source identity']:
            self.assertIn(component, status)
        self.assertIn('known limitations, not closed', status)
        self.assertIn('not release blockers', status)
        self.assertIn('source_status: not_reconciled', status)
        self.assertIn('declared license only; upstream notice text not found', status)
        self.assertIn('including copies in distributed layers and', status)
        self.assertIn('Neither requirement is covered by the accepted residuals', status)

    def test_image_contains_notice_bytes_with_gap_disclosure(self):
        import hashlib
        bundle = ROOT / 'docs/third-party/hex184-resolution/bundle'
        manifest = json.loads((bundle / 'manifest.json').read_text())
        for notice in manifest['notices']:
            data = (bundle / notice['file']).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(), notice['sha256'])
            self.assertEqual(len(data), notice['bytes'])
        dockerfile = (APP / 'Dockerfile').read_text()
        self.assertIn('COPY docs/third-party/hex184-resolution/bundle/ '
                      '/usr/share/doc/agent-box-hermes/third-party/', dockerfile)
        self.assertIn('COPY docs/third-party/NOTICE-STATUS.md ', dockerfile)
        self.assertTrue(included('docs/third-party/NOTICE-STATUS.md'))
        status = (ROOT / 'docs/third-party/NOTICE-STATUS.md').read_text()
        self.assertIn('Incomplete', status)
        self.assertIn('reconciliation.json', status)
