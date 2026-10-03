"""Exercise startup command ordering and the operator compose contract."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

APP = Path(__file__).resolve().parents[1]


class RuntimeTest(unittest.TestCase):
    def test_compose_uses_writable_run_dir_and_configurable_loopback_port(self):
        compose = (APP / 'compose.yaml').read_text()
        self.assertIn('      AGENT_BOX_RUN_DIR: /tmp/agent-box', compose)
        self.assertIn('      - "127.0.0.1:${AGENT_BOX_PORT:-65005}:65005"', compose)

    def test_prepare_home_repairs_omp_before_subscription_startup(self):
        # Capture real shell invocations without touching the host's /home/agent.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            log = root / 'commands'
            for name in ('mkdir', 'chown', 'python3', 's6-setuidgid'):
                command = root / name
                command.write_text('#!/bin/sh\nprintf "%s" "${0##*/}" >> "$COMMAND_LOG"\n'
                                   'printf " <%s>" "$@" >> "$COMMAND_LOG"\nprintf "\\n" >> "$COMMAND_LOG"\n')
                command.chmod(0o755)
            subprocess.run(['/bin/sh', str(APP / 'backend/infra/backend-box/prepare-home.sh')],
                           env={**os.environ, 'PATH': str(root), 'COMMAND_LOG': str(log)}, check=True)
            self.assertEqual(log.read_text().splitlines(), [
                'mkdir <-p> </home/agent/.omp>',
                'chown <hermes:hermes> </home/agent>',
                'chown <-R> <hermes:hermes> </home/agent/.omp>',
                'python3 </opt/subscription.py>',
                's6-setuidgid <hermes> </opt/install-runtime-tools.sh>',
            ])


if __name__ == '__main__':
    unittest.main()
