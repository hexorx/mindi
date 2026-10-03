"""Exercise the operator helper against private, nested legacy home state."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'migrate-home-owner.sh'


@unittest.skipUnless(os.geteuid() == 0, 'requires root for real UID upgrade/rollback')
class HomeMigrationTest(unittest.TestCase):
    def migrate(self, home, old, new, check=True):
        return subprocess.run(['sh', str(SCRIPT)], env={**os.environ,
            'HOME_ROOT': str(home), 'OLD_UID': str(old), 'OLD_GID': str(old),
            'NEW_UID': str(new), 'NEW_GID': str(new)}, check=check, capture_output=True)

    def test_upgrade_and_rollback_allow_nested_writes_preserve_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o755)
            home = root / 'home'
            home.mkdir(mode=0o700)
            dirs = [home]
            files = []
            for name in ('.hermes', '.omp', '.claude', '.local', 'backend-state'):
                parent = home / name
                parent.mkdir(mode=0o700)
                nested = parent / 'nested'
                nested.mkdir(mode=0o700)
                state = nested / 'state'
                state.write_bytes(b'synthetic retained login or backend state\n')
                state.chmod(0o600)
                dirs.extend([parent, nested])
                files.append(state)
            outside = root / 'outside'
            outside.write_bytes(b'outside fixture')
            os.chown(outside, 10000, 10000)
            (home / 'outside-link').symlink_to(outside)
            unrelated = home / 'unrelated'
            unrelated.write_bytes(b'unrelated fixture')
            os.chown(unrelated, 12345, 12346)
            for path in [*dirs, *files]:
                os.chown(path, 10000, 10000)
            before = [(p.read_bytes(), p.stat().st_mode, p.stat().st_mtime_ns) for p in files]
            writer = ('import pathlib,sys; '
                      '[(p.open("ab").close(), (p.parent / sys.argv[1]).touch()) '
                      'for p in map(pathlib.Path, sys.argv[2:])]')
            failed = subprocess.run([sys.executable, '-c', writer, 'before', *map(str, files)],
                                    user=1000, group=1000, extra_groups=[], capture_output=True)
            self.assertNotEqual(failed.returncode, 0)
            for old, new in ((10000, 1000), (1000, 10000)):
                for _ in range(2):  # Migration is repeatable.
                    self.migrate(home, old, new)
                for path in [*dirs, *files]:
                    self.assertEqual((path.stat().st_uid, path.stat().st_gid), (new, new))
                subprocess.run([sys.executable, '-c', writer, str(new), *map(str, files)],
                               user=new, group=new, extra_groups=[], check=True)
                self.assertEqual(before, [(p.read_bytes(), p.stat().st_mode, p.stat().st_mtime_ns) for p in files])
                self.assertEqual((outside.stat().st_uid, outside.stat().st_gid), (10000, 10000))
                self.assertEqual((unrelated.stat().st_uid, unrelated.stat().st_gid), (12345, 12346))

    def test_hardlink_refuses_before_changing_any_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            state = home / 'state'
            state.write_text('synthetic state')
            os.link(state, home / 'second-name')
            os.chown(home, 10000, 10000)
            os.chown(state, 10000, 10000)
            self.assertNotEqual(self.migrate(home, 10000, 1000, check=False).returncode, 0)
            self.assertEqual(home.stat().st_uid, 10000)
            self.assertEqual(state.stat().st_uid, 10000)


if __name__ == '__main__':
    unittest.main()
