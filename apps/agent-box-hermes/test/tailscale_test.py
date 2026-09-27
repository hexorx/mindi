import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch
import unittest

APP = Path(__file__).parents[1]
REPO = APP.parents[1]


def load():
    spec = importlib.util.spec_from_file_location("tailscale_runtime", APP / "runtime/tailscale.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


ts = load()
PRIVATE_SERVE = {"TCP": {"443": {"HTTPS": True}},
                 "Web": {"box.tailnet.ts.net:443": {"Handlers": {"/": {"Proxy": ts.SERVE_TARGET}}}}}


class FakeTailscale:
    """Models the tailscale CLI surface the manager uses, including key consumption."""

    def __init__(self, backend="NeedsLogin", valid_keys=(), https=True, prefs_ok=True):
        self.backend = backend
        self.valid_keys = set(valid_keys)
        self.https = https
        self.prefs_ok = prefs_ok
        self.serve = {}
        self.calls = []

    def __call__(self, args):
        self.calls.append(list(args))
        ok = subprocess.CompletedProcess(args, 0, "", "")
        fail = subprocess.CompletedProcess(args, 1, "", "")
        if args == ["status", "--json"]:
            return subprocess.CompletedProcess(args, 0, json.dumps({"BackendState": self.backend}), "")
        if args[0] == "up":
            if any(a.startswith("--webclient") for a in args):
                return fail  # Unsupported by the pinned Tailscale up CLI.
            key = next((a.split("file:", 1)[1] for a in args if a.startswith("--auth-key=file:")), None)
            if key is None:
                return fail
            value = Path(key).read_text().strip()
            if value not in self.valid_keys:
                return fail
            self.valid_keys.discard(value)
            self.backend = "Running"
            return ok
        if args[0] == "set":
            return ok if self.prefs_ok else fail
        if args == ["serve", "reset"]:
            self.serve = {}
            return ok
        if args == ["serve", "status", "--json"]:
            return subprocess.CompletedProcess(args, 0, json.dumps(self.serve), "")
        if args[0] == "serve":
            if not self.https:
                return fail
            self.serve = json.loads(json.dumps(PRIVATE_SERVE))
            return ok
        raise AssertionError("unexpected CLI call: " + " ".join(args))

    def called(self, prefix):
        return [c for c in self.calls if c[:len(prefix)] == prefix]


class Base(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.state = self.root / "state"
        self.state.mkdir()
        self.status_file = self.root / "run/network.json"
        self.key = self.root / "tailscale_authkey"
        self.now = [0.0]
        self.config = ts.load_config({"AGENT_BOX_TAILSCALE": "1", "TS_AUTHKEY_FILE": str(self.key),
                                      "AGENT_BOX_TAILSCALE_HOSTNAME": "helper-box"})

    def manager(self, fake):
        return ts.Manager(self.config, fake, self.state, self.status_file, log=lambda _: None,
                          clock=lambda: self.now[0])

    def status(self):
        return json.loads(self.status_file.read_text())


class ConfigTest(Base):
    def test_disabled_by_default_and_explicitly(self):
        for env in ({}, {"AGENT_BOX_TAILSCALE": "0"}, {"AGENT_BOX_TAILSCALE": "false"}):
            self.assertEqual(ts.load_config(env), {"enabled": False})

    def test_rejects_invalid_settings(self):
        for env in ({"AGENT_BOX_TAILSCALE": "yes"},
                    {"AGENT_BOX_TAILSCALE": "1", "AGENT_BOX_TAILSCALE_HOSTNAME": "Helper"},
                    {"AGENT_BOX_TAILSCALE": "1", "AGENT_BOX_TAILSCALE_HOSTNAME": "a" * 64},
                    {"AGENT_BOX_TAILSCALE": "1", "AGENT_BOX_TAILSCALE_HOSTNAME": "-x"},
                    {"AGENT_BOX_TAILSCALE": "1", "AGENT_BOX_TAILSCALE_LOGIN_SERVER": "https://x/p?q"},
                    {"AGENT_BOX_TAILSCALE": "1", "AGENT_BOX_TAILSCALE_LOGIN_SERVER": "ftp://x"},
                    {"AGENT_BOX_TAILSCALE": "1", "TS_AUTHKEY_FILE": "relative"}):
            with self.assertRaises(ts.ConfigError):
                ts.load_config(env)

    def test_state_dir_must_be_a_dedicated_volume(self):
        chowned = []
        with self.assertRaises(ts.ConfigError):
            ts.prepare_state_dir(self.state, ismount=lambda _: False, chown=lambda *a: chowned.append(a))
        link = self.root / "link"
        link.symlink_to(self.state)
        with self.assertRaises(ts.ConfigError):
            ts.prepare_state_dir(link, ismount=lambda _: True, chown=lambda *a: chowned.append(a))
        ts.prepare_state_dir(self.state, ismount=lambda _: True, chown=lambda *a: chowned.append(a))
        self.assertEqual(self.state.stat().st_mode & 0o777, 0o700)
        self.assertEqual(chowned, [(self.state, 0, 0)])

    def test_status_file_matches_health_contract(self):
        ts.write_status(self.status_file, "ready", "ok")
        self.assertEqual(self.status(), {"status": "ready", "code": "ok"})
        self.assertEqual(self.status_file.stat().st_mode & 0o777, 0o644)


class LifecycleTest(Base):
    def test_enrolls_with_key_file_and_locks_prefs(self):
        self.key.write_text("tskey-fixture-one\n")
        fake = FakeTailscale(valid_keys={"tskey-fixture-one"})
        self.manager(fake).reconcile()
        self.assertEqual(self.status(), {"status": "ready", "code": "ok"})
        (up,) = fake.called(["up"])
        self.assertIn("--auth-key=file:" + str(self.key), up)
        self.assertIn("--reset", up)
        self.assertIn("--hostname=helper-box", up)
        for pref in ts.UP_PREFS:
            self.assertIn(pref, up)
        self.assertNotIn("--webclient=false", up)
        self.assertIn("--shields-up=false", up)
        for pref in ts.LOCKED_PREFS:
            self.assertIn(pref, fake.called(["set"])[0])
        self.assertNotIn("tskey-fixture-one", json.dumps(fake.calls))
        self.assertTrue((self.state / ts.ENROLLED_MARKER).exists())

    def test_restart_reuses_identity_without_reading_key(self):
        (self.state / ts.ENROLLED_MARKER).touch()
        fake = FakeTailscale(backend="Running")
        self.manager(fake).reconcile()
        self.assertEqual(self.status(), {"status": "ready", "code": "ok"})
        self.assertEqual(fake.called(["up"]), [])

    def test_missing_key_before_first_enrollment(self):
        fake = FakeTailscale()
        self.manager(fake).reconcile()
        self.assertEqual(self.status(), {"status": "not_ready", "code": "credential_missing"})
        self.assertEqual(fake.called(["serve"]), [])

    def test_revocation_then_reenrollment_with_new_key(self):
        self.key.write_text("tskey-fixture-one")
        fake = FakeTailscale(valid_keys={"tskey-fixture-one"})
        manager = self.manager(fake)
        manager.reconcile()
        self.assertEqual(self.status()["status"], "ready")
        fake.backend = "NeedsLogin"  # node key expired or node deleted by an admin
        manager.reconcile()
        self.assertEqual(self.status(), {"status": "not_ready", "code": "not_enrolled"})
        self.assertEqual(len(fake.called(["up"])), 1, "consumed key must not be replayed")
        self.key.unlink()
        manager.reconcile()
        self.assertEqual(self.status(), {"status": "not_ready", "code": "not_enrolled"})
        fake.valid_keys.add("tskey-fixture-two")
        self.key.write_text("tskey-fixture-two")
        manager.reconcile()
        self.assertEqual(self.status(), {"status": "ready", "code": "ok"})
        self.assertEqual(len(fake.called(["up"])), 2)

    def test_rejected_key_is_tried_once(self):
        self.key.write_text("tskey-revoked")
        fake = FakeTailscale()
        manager = self.manager(fake)
        manager.reconcile()
        manager.reconcile()
        self.assertEqual(self.status(), {"status": "not_ready", "code": "unauthorized"})
        self.assertEqual(len(fake.called(["up"])), 1)

    def test_machine_auth_pending_is_not_enrolled(self):
        fake = FakeTailscale(backend="NeedsMachineAuth")
        self.manager(fake).reconcile()
        self.assertEqual(self.status(), {"status": "not_ready", "code": "not_enrolled"})


class ServeTest(Base):
    def test_private_serve_policy(self):
        self.assertTrue(ts.serve_config_is_private(PRIVATE_SERVE))
        self.assertTrue(ts.serve_config_is_private({**PRIVATE_SERVE, "AllowFunnel": {}}))
        web = PRIVATE_SERVE["Web"]
        rejected = [
            {},
            {**PRIVATE_SERVE, "AllowFunnel": {"box.tailnet.ts.net:443": True}},
            {**PRIVATE_SERVE, "TCP": {"443": {"HTTPS": True}, "5900": {"TCPForward": "127.0.0.2:5900"}}},
            {**PRIVATE_SERVE, "TCP": {"443": {"TCPForward": "127.0.0.2:5900"}}},
            {**PRIVATE_SERVE, "Web": {"box.tailnet.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.2:6080"}}}}},
            {**PRIVATE_SERVE, "Web": {**web, "other.tailnet.ts.net:443": web["box.tailnet.ts.net:443"]}},
            {**PRIVATE_SERVE, "Services": {"svc:x": {}}},
            [],
        ]
        for config in rejected:
            self.assertFalse(ts.serve_config_is_private(config), config)

    def test_foreign_serve_or_funnel_is_replaced(self):
        (self.state / ts.ENROLLED_MARKER).touch()
        fake = FakeTailscale(backend="Running")
        fake.serve = {**PRIVATE_SERVE, "AllowFunnel": {"box.tailnet.ts.net:443": True}}
        self.manager(fake).reconcile()
        self.assertEqual(self.status(), {"status": "ready", "code": "ok"})
        self.assertEqual(fake.serve, PRIVATE_SERVE)
        self.assertLess(fake.calls.index(["serve", "reset"]),
                        fake.calls.index(["serve", "--bg", "--yes", "--https=443", ts.SERVE_TARGET]))

    def test_serve_unavailable_degrades_and_backs_off(self):
        (self.state / ts.ENROLLED_MARKER).touch()
        fake = FakeTailscale(backend="Running", https=False)
        manager = self.manager(fake)
        manager.reconcile()
        self.assertEqual(self.status(), {"status": "degraded", "code": "unavailable"})
        self.assertEqual(fake.serve, {})
        manager.reconcile()
        self.assertEqual(len(fake.called(["serve", "--bg"])), 1)
        self.now[0] += ts.SERVE_RETRY_SECONDS
        fake.https = True
        manager.reconcile()
        self.assertEqual(self.status(), {"status": "ready", "code": "ok"})

    def test_prefs_failure_degrades_without_serving(self):
        (self.state / ts.ENROLLED_MARKER).touch()
        fake = FakeTailscale(backend="Running", prefs_ok=False)
        self.manager(fake).reconcile()
        self.assertEqual(self.status(), {"status": "degraded", "code": "unavailable"})
        self.assertEqual(fake.called(["serve", "--bg"]), [])


class MainTest(Base):
    def run_main(self, env):
        with patch.object(ts, "STATUS_FILE", self.status_file), \
             patch.object(ts.os, "execv", side_effect=SystemExit("paused")) as execv, \
             patch.object(ts.subprocess, "Popen", side_effect=AssertionError("tailscaled started")):
            with self.assertRaises(SystemExit):
                ts.main(env)
        execv.assert_called_once_with("/command/s6-pause", ["s6-pause"])

    def test_disabled_mode_never_starts_tailscaled(self):
        self.run_main({})
        self.assertEqual(self.status(), {"status": "disabled", "code": "disabled"})

    def test_invalid_config_pauses_not_ready(self):
        self.run_main({"AGENT_BOX_TAILSCALE": "maybe"})
        self.assertEqual(self.status(), {"status": "not_ready", "code": "unavailable"})

    def test_daemon_needs_no_tun_and_keeps_proxies_off_forwarded_loopback(self):
        args = ts.daemon_args()
        self.assertIn("--tun=userspace-networking", args)
        self.assertIn("--statedir=/var/lib/tailscale", args)
        proxies = [a for a in args if a.startswith(("--socks5-server=", "--outbound-http-proxy-listen="))]
        self.assertEqual(len(proxies), 2)
        self.assertTrue(all("=127.0.0.2:" in a for a in proxies))


class WiringTest(unittest.TestCase):
    def test_raw_vnc_never_binds_forwarded_loopback(self):
        for path in ("s6-rc.d/wayvnc/run", "s6-rc.d/novnc/run", "desktop/nginx.conf", "runtime/health.py"):
            text = (APP / path).read_text()
            for port in ("5900", "6080"):
                self.assertNotRegex(text, r"127\.0\.0\.1[:\" ,)]+" + port, path)

    def test_service_is_independent_of_desktop(self):
        unit = APP / "s6-rc.d/tailscale"
        self.assertEqual((unit / "type").read_text().strip(), "longrun")
        self.assertEqual([p.name for p in (unit / "dependencies.d").iterdir()], ["base"])
        self.assertTrue((APP / "s6-rc.d/user/contents.d/tailscale").exists())
        for dependency in (APP / "s6-rc.d").glob("*/dependencies.d/tailscale"):
            self.fail("desktop service depends on tailscale: " + str(dependency))

    def test_image_and_stacks_need_no_tun_capability_or_funnel(self):
        dockerfile = (APP / "Dockerfile").read_text()
        self.assertRegex(dockerfile, r"FROM tailscale/tailscale:v[0-9.]+@sha256:[0-9a-f]{64} AS tailscale")
        def code(path):
            return "\n".join(line for line in path.read_text().splitlines()
                             if not line.lstrip().startswith("#")).lower()
        base = code(REPO / "stacks/agent-box-hermes/compose.yaml")
        overlay = code(REPO / "stacks/agent-box-hermes/compose.tailscale.yaml")
        self.assertNotIn("tailscale", base)
        for text in (base, overlay, code(APP / "Dockerfile")):
            for forbidden in ("/dev/net/tun", "net_admin", "cap_add", "devices:", "privileged:",
                              "network_mode", "funnel"):
                self.assertNotIn(forbidden, text)


if __name__ == "__main__":
    unittest.main()
