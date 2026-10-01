"""Negative tests for the build-time web-client absence gate."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

APP = Path(__file__).resolve().parents[1]


class NoWebGateTests(unittest.TestCase):
    def run_gate(self, case):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            go = root / 'go'
            go.write_text('''#!/bin/sh
case "$1" in
list)
  echo 'tailscale.com/cmd/tailscale'
  [ "$CASE" != embed ] || echo 'tailscale.com/client/web build/index.html'
  ;;
version)
  [ "$CASE" = tag ] || echo 'build -tags=ts_kube,ts_package_container,ts_omit_webclient'
  [ "$CASE" != dependency ] || echo 'dep github.com/tailscale/web-client-prebuilt v0.0.0'
  ;;
tool)
  [ "$CASE" != nm_error ] || exit 1
  echo '123 T main.main'
  [ "$CASE" != symbol ] || echo '123 D tailscale.com/client/web.assets'
  ;;
esac
exit 0
''')
            cli = root / 'tailscale'
            cli.write_text('''#!/bin/sh
[ "$CASE" != available ] || exit 0
[ "$CASE" != daemon_error ] || { echo 'cannot connect to tailscaled'; exit 1; }
echo 'tailscale: unknown subcommand: web'
exit 1
''')
            go.chmod(0o755)
            cli.chmod(0o755)
            env = dict(os.environ, PATH=str(root) + os.pathsep + os.environ['PATH'], CASE=case)
            return subprocess.run(['sh', str(APP / 'build/verify_tailscale_no_web.sh'), tmp],
                                  env=env, capture_output=True, text=True)

    def test_omitted_client_passes(self):
        result = self.run_gate('absent')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_incomplete_proof_fails(self):
        for case in ('embed', 'tag', 'dependency', 'symbol', 'nm_error', 'available', 'daemon_error'):
            with self.subTest(case=case):
                self.assertNotEqual(self.run_gate(case).returncode, 0)

    def test_dockerfile_builds_both_binaries_and_runs_gate(self):
        dockerfile = (APP / 'Dockerfile').read_text()
        self.assertIn('-tags=ts_kube,ts_package_container,ts_omit_webclient', dockerfile)
        self.assertIn('./cmd/tailscale ./cmd/tailscaled', dockerfile)
        self.assertIn('&& sh /opt/build/verify_tailscale_no_web.sh', dockerfile)
