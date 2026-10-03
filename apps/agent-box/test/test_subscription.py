import importlib.util
import json
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
            chown.assert_called_once_with(home, 10000, 10001)
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
