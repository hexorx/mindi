"""Exercise first install, offline restart, and independent nonfatal failures."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

APP = Path(__file__).resolve().parents[1]
SCRIPT = APP / 'base/infra/agent-box/install-runtime-tools.sh'
INPUTS = SCRIPT.parent / 'runtime-tools'


class RuntimeToolsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.env = {**os.environ, 'HOME': str(self.root / 'home'),
                    'PATH': f'{self.bin}:{os.environ["PATH"]}',
                    'MINDI_RUNTIME_INPUTS': str(INPUTS), 'CALLS': str(self.root / 'calls')}
        self.stub('node', 'exit 0\n')
        self.stub('npm', '''
printf 'npm\n' >> "$CALLS"
[ "${FAIL_NPM:-0}" = 0 ] || exit 1
while [ "$1" != --prefix ]; do shift; done
shift
mkdir -p "$1/node_modules/.bin"
printf '#!/bin/sh\necho "2.1.266 (Claude Code)"\n' > "$1/node_modules/.bin/claude"
printf '#!/bin/sh\nexit 0\n' > "$1/node_modules/.bin/claude-agent-acp"
chmod +x "$1/node_modules/.bin/"*
''')
        self.stub('curl', '''
printf 'curl\n' >> "$CALLS"
[ "${FAIL_CURL:-0}" = 0 ] || exit 1
while [ "$1" != -o ]; do shift; done
shift
printf fake-deb > "$1"
''')
        self.stub('sha256sum', '''
if [ "${1:-}" = -c ]; then
    cat >/dev/null
    [ "${FAIL_SHA:-0}" = 0 ]
else
    /usr/bin/sha256sum "$@"
fi
''')
        self.stub('dpkg', 'echo amd64\n')
        self.stub('dpkg-deb', '''
mkdir -p "$3/opt/google/chrome"
printf '#!/bin/sh\necho "Google Chrome 154.0.8037.97 "\n' > "$3/opt/google/chrome/chrome"
chmod +x "$3/opt/google/chrome/chrome"
''')

    def stub(self, name, body):
        p = self.bin / name
        p.write_text('#!/bin/sh\nset -eu\n' + body)
        p.chmod(0o755)

    def run_installer(self, **env):
        return subprocess.run(['sh', str(SCRIPT)], env={**self.env, **env},
                              capture_output=True, text=True, check=True)

    def test_fresh_install_and_second_offline_start_skip_downloads(self):
        first = self.run_installer()
        self.assertIn('installed Claude', first.stdout)
        self.assertIn('installed Chrome', first.stdout)
        calls = (self.root / 'calls').read_text()
        second = self.run_installer(FAIL_NPM='1', FAIL_CURL='1')
        self.assertEqual(second.stdout.count('already installed; skipping'), 2)
        self.assertEqual(calls, (self.root / 'calls').read_text())
        self.assertTrue((self.root / 'home/.local/bin/claude').is_file())
        self.assertTrue((self.root / 'home/.local/share/mindi-tools/chrome/opt/google/chrome/chrome').is_file())

    def test_changed_version_is_reinstalled_instead_of_skipped(self):
        self.run_installer()
        cli = self.root / 'home/.local/bin/claude'
        cli.write_text('#!/bin/sh\necho "0.0.0 (Claude Code)"\n')
        result = self.run_installer()
        self.assertIn('installed Claude', result.stdout)
        self.assertIn('Chrome 154.0.8037.97 already installed', result.stdout)
        self.assertEqual(subprocess.check_output([str(cli)], text=True).strip(),
                         '2.1.266 (Claude Code)')

    def test_claude_failure_does_not_prevent_chrome_or_startup_and_retries(self):
        result = self.run_installer(FAIL_NPM='1')
        self.assertIn('claude install failed; continuing startup', result.stderr)
        self.assertIn('installed Chrome', result.stdout)
        self.assertFalse((self.root / 'home/.local/bin/claude').exists())
        retry = self.run_installer()
        self.assertIn('installed Claude', retry.stdout)
        self.assertIn('Chrome 154.0.8037.97 already installed', retry.stdout)

    def test_checksum_failure_never_publishes_chrome_and_retries(self):
        result = self.run_installer(FAIL_SHA='1')
        self.assertIn('chrome install failed; continuing startup', result.stderr)
        self.assertFalse((self.root / 'home/.local/share/mindi-tools/chrome').exists())
        self.assertIn('installed Chrome', self.run_installer().stdout)

    def test_both_downloads_fail_without_failing_startup(self):
        result = self.run_installer(FAIL_NPM='1', FAIL_CURL='1')
        self.assertEqual(result.stderr.count('continuing startup'), 2)

    def test_installer_is_bounded(self):
        self.stub('timeout', 'printf "timeout %s %s %s\\n" "$1" "$2" "$3" >> "$CALLS"\nexit 124\n')
        result = self.run_installer()
        self.assertEqual(result.stderr.count('continuing startup'), 2)
        self.assertEqual((self.root / 'calls').read_text().count('timeout --kill-after=5 120 sh'), 2)

    def test_recipes_do_not_install_vendor_tools(self):
        base = (APP / 'base/infra/agent-box/Dockerfile').read_text()
        backend = (APP / 'backend/infra/backend-box/Dockerfile').read_text()
        self.assertNotIn('google-chrome-stable', base)
        self.assertNotIn('npm install --prefix /opt/mindi-native', backend)
        self.assertNotIn('@anthropic-ai/claude-code', backend)
        self.assertNotIn('/usr/local/bin/google-chrome', base + backend)
        self.assertIn('s6-setuidgid hermes /opt/install-runtime-tools.sh',
                      (APP / 'backend/infra/backend-box/prepare-home.sh').read_text())
        self.assertNotIn('/usr/bin/google-chrome-stable',
                         (APP / 'backend/packages/desktop/src/profiles.ts').read_text())


if __name__ == '__main__':
    unittest.main()
