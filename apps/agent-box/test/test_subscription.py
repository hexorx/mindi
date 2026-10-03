import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

APP = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('subscription', APP / 'backend/infra/backend-box/subscription.py')
subscription = importlib.util.module_from_spec(spec)
spec.loader.exec_module(subscription)
spec = importlib.util.spec_from_file_location('smoke', APP / 'test/smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class SubscriptionTest(unittest.TestCase):
    def setUp(self):
        account = patch.object(subscription.pwd, "getpwnam", return_value=SimpleNamespace(pw_uid=10000, pw_gid=10001))
        self.account = account.start()
        self.addCleanup(account.stop)

    def test_seed_uses_runtime_account_uid_and_gid(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(subscription.os, "chown") as chown, patch.object(subscription.os, "fchown") as fchown:
            home = Path(directory) / ".hermes"
            subscription.seed(home, {})
            self.account.assert_called_once_with("hermes")
            chown.assert_not_called()
            self.assertEqual(fchown.call_count, 2)
            self.assertEqual(fchown.call_args.args[1:], (10000, 10001))

    def test_fresh_home_and_restart_preserve_logins_and_operator_config(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(subscription.os, 'chown'), patch.object(subscription.os, 'fchown'):
            home = Path(directory) / '.hermes'
            subscription.seed(home, {})
            config = home / 'config.yaml'
            self.assertEqual(json.loads(config.read_text())['model']['provider'], 'openai-codex')
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            login = home / 'auth.json'
            login.write_text('synthetic saved login')
            config.write_text('{"model":"operator choice"}')
            subscription.seed(home, {})
            self.assertEqual(config.read_text(), '{"model":"operator choice"}')
            self.assertEqual(login.read_text(), 'synthetic saved login')
            self.assertFalse((home / '.env').exists())

    def test_existing_private_files_repaired_without_rewriting(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / '.hermes'
            home.mkdir()
            paths = [home / name for name in ('config.yaml', 'auth.json', 'unrelated')]
            for path in paths:
                path.write_bytes(b'synthetic private state\n')
                path.chmod(0o640)
            before = [(p.read_bytes(), p.stat().st_mode, p.stat().st_mtime_ns) for p in paths]
            repaired = []
            with patch.object(subscription.os, 'fchown', side_effect=lambda fd, uid, gid: repaired.append((os.fstat(fd).st_ino, uid, gid))):
                subscription.seed(home, {})
            self.assertEqual(repaired, [(p.stat().st_ino, 10000, 10001) for p in [home, *paths[:2]]])
            self.assertEqual(before, [(p.read_bytes(), p.stat().st_mode, p.stat().st_mtime_ns) for p in paths])

    def test_links_and_nonregular_files_are_not_repaired(self):
        for name in ('config.yaml', 'auth.json'):
            for kind in ('symlink', 'hardlink', 'fifo'):
                with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as directory:
                    root = Path(directory)
                    home = root / '.hermes'
                    home.mkdir()
                    target = root / 'unrelated'
                    target.write_text('untouched')
                    path = home / name
                    if kind == 'symlink':
                        path.symlink_to(target)
                    elif kind == 'hardlink':
                        os.link(target, path)
                    else:
                        os.mkfifo(path)
                    with patch.object(subscription.os, 'fchown') as chown:
                        with self.assertRaises((OSError, ValueError)):
                            subscription.seed(home, {})
                        self.assertEqual(chown.call_count, 1)  # directory only
                    self.assertEqual(target.read_text(), 'untouched')

    def test_generated_config_link_does_not_skip_login_repair(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / 'config.yaml').symlink_to('.agent-box/current/config.yaml')
            login = home / 'auth.json'
            login.write_text('saved login')
            with patch.object(subscription.os, 'fchown') as chown:
                subscription.seed(home, {})
                self.assertEqual(chown.call_count, 2)
            self.assertEqual(login.read_text(), 'saved login')

    def test_symlinked_home_ancestor_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'real').mkdir()
            (root / 'link').symlink_to(root / 'real', target_is_directory=True)
            with self.assertRaises(ValueError):
                subscription.seed(root / 'link' / 'nested' / '.hermes', {})
            self.assertFalse((root / 'real' / 'nested').exists())

    @unittest.skipUnless(os.geteuid() == 0, 'requires root to exercise legacy UID migration')
    def test_persistent_home_upgrade_is_readable_as_runtime_account(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            root.chmod(0o755)
            home = root / '.hermes'
            home.mkdir(mode=0o700)
            os.chown(home, 1000, 1000)
            paths = [home / name for name in ('config.yaml', 'auth.json', 'unrelated')]
            for path in paths:
                path.write_text('synthetic saved state')
                path.chmod(0o600)
                os.chown(path, 1000, 1000)
            before = [(p.read_bytes(), p.stat().st_mode, p.stat().st_mtime_ns) for p in paths]
            for _ in range(2):
                subscription.seed(home, {})
                for path in paths[:2]:
                    self.assertEqual((path.stat().st_uid, path.stat().st_gid), (10000, 10001))
                subprocess.run([sys.executable, '-c',
                                'import pathlib,sys; [p.read_bytes() for p in map(pathlib.Path, sys.argv[1:])]',
                                *map(str, paths[:2])], user=10000, group=10001, extra_groups=[], check=True)
            self.assertEqual((paths[2].stat().st_uid, paths[2].stat().st_gid), (1000, 1000))
            self.assertEqual(before, [(p.read_bytes(), p.stat().st_mode, p.stat().st_mtime_ns) for p in paths])

    def test_paid_provider_rejected_without_echoing_values(self):
        with tempfile.TemporaryDirectory() as directory:
            for env in ({'HERMES_INFERENCE_PROVIDER': 'openai'},
                        {'HERMES_INFERENCE_BASE_URL': 'https://private.invalid'},
                        {'HERMES_INFERENCE_MODEL': 'bad\nvalue'}):
                with self.assertRaisesRegex(ValueError, 'values redacted'):
                    subscription.seed(Path(directory) / '.hermes', env)
                self.assertFalse((Path(directory) / '.hermes').exists())

    def test_real_smoke_refuses_missing_subscription_state(self):
        for raw in ('{}', '{"providers":{"openai":{}}}', 'not json'):
            with self.assertRaises(ValueError):
                smoke.subscription_document(raw)
        raw = '{"providers":{"openai-codex":{"fixture":true}}}'
        self.assertEqual(smoke.subscription_document(raw), raw.encode())

    def test_active_init_executes_subscription_setup(self):
        recipe = (APP / 'backend/infra/backend-box/Dockerfile').read_text()
        self.assertIn('ENTRYPOINT ["/init"]', recipe)
        self.assertIn('COPY infra/backend-box/subscription.py /out/opt/subscription.py', recipe)
        self.assertIn('python3 /opt/subscription.py', (APP / 'backend/infra/backend-box/prepare-home.sh').read_text())
        base_recipe = (APP / 'base/infra/agent-box/Dockerfile').read_text()
        self.assertNotIn('ssh-keygen -A', base_recipe)
        self.assertIn('&& rm -f /etc/ssh/ssh_host_*_key /etc/ssh/ssh_host_*_key.pub', base_recipe)
        self.assertNotIn('API_KEY', (APP / 'compose.yaml').read_text())


if __name__ == '__main__':
    unittest.main()
