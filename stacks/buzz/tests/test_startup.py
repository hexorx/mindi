"""Process-level tests: real children, HTTP listeners, deadlines and signals."""

import importlib.util
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "startup.py"
spec = importlib.util.spec_from_file_location("startup", SCRIPT)
startup = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = startup
spec.loader.exec_module(startup)

FAKE = r"""
import http.server, os, signal, threading, time
from pathlib import Path
count = Path(os.environ["COUNT"])
n = int(count.read_text()) + 1 if count.exists() else 1
count.write_text(str(n))
mode = os.environ["MODE"]
def stopped(sig, frame):
    Path(os.environ["SIGNAL_FILE"]).write_text(str(sig))
    raise SystemExit(0)
signal.signal(signal.SIGTERM, signal.SIG_IGN if mode == "ignore" else stopped)
signal.signal(signal.SIGINT, stopped)
if mode == "exit":
    raise SystemExit(int(os.environ.get("EXIT_CODE", "7")))
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if mode == "trickle":
            for byte in b"HTTP/1.1 200 OK\r\n":
                self.connection.sendall(bytes([byte]))
                time.sleep(0.15)
            return
        if mode == "blackhole":
            time.sleep(10)
            return
        self.send_response(503 if mode == "unhealthy" else 200)
        self.end_headers()
    def log_message(self, *args):
        pass
if mode in ("healthy", "unhealthy", "blackhole", "trickle", "recover") and (mode != "recover" or n >= 2):
    class Server(http.server.ThreadingHTTPServer):
        allow_reuse_address = True
        daemon_threads = True
    server = Server(("127.0.0.1", int(os.environ["BUZZ_HEALTH_PORT"])), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
time.sleep(float(os.environ.get("LIFETIME", "30")))
"""


class SupervisorTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.fake = self.root / "relay.py"
        self.fake.write_text(FAKE)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.env = {
            **os.environ,
            "BUZZ_STARTUP_TIMEOUT_SECONDS": "0.4",
            "BUZZ_STARTUP_ATTEMPTS": "3",
            "BUZZ_STARTUP_BACKOFF_SECONDS": "0.1",
            "BUZZ_STARTUP_STOP_GRACE_SECONDS": "0.1",
            "BUZZ_HEALTH_PORT": str(port),
            "COUNT": str(self.root / "count"),
            "SIGNAL_FILE": str(self.root / "signal"),
        }
        self.children = []

    def tearDown(self):
        for child, output in self.children:
            if child.poll() is None:
                child.terminate()
                child.wait(timeout=3)
            output.close()
        self.temp.cleanup()

    def launch(self, mode, **env):
        output = (self.root / "output").open("wb")
        child = subprocess.Popen(
            [sys.executable, "-B", str(SCRIPT), sys.executable, "-u", str(self.fake)],
            env={**self.env, "MODE": mode, **env},
            stdout=output,
            stderr=output,
        )
        self.children.append((child, output))
        return child

    def logs(self):
        return (self.root / "output").read_text()

    def count(self):
        return int((self.root / "count").read_text())

    def wait_for(self, text):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            if text in self.logs():
                return
            time.sleep(0.02)
        self.fail(f"missing {text}: {self.logs()}")

    def test_hung_probe_retries_with_backoff_and_exits_nonzero(self):
        started = time.monotonic()
        child = self.launch("hang")
        self.assertEqual(child.wait(timeout=5), 1)
        self.assertEqual(self.count(), 3)
        self.assertIn("retrying startup in 0.1s", self.logs())
        self.assertIn("retrying startup in 0.2s", self.logs())
        self.assertIn("attempts exhausted", self.logs())
        self.assertLess(time.monotonic() - started, 4)

    def test_sigterm_ignoring_child_is_killed_before_retry(self):
        child = self.launch("ignore", BUZZ_STARTUP_ATTEMPTS="2")
        self.assertEqual(child.wait(timeout=4), 1)
        self.assertEqual(self.count(), 2)

    def test_healthy_process_outlives_startup_deadline(self):
        child = self.launch("healthy", LIFETIME="1.2")
        self.assertEqual(child.wait(timeout=4), 0)
        self.assertEqual(self.count(), 1)
        self.assertIn("deadline disarmed", self.logs())
        self.assertNotIn("timed out", self.logs())

    def test_second_attempt_recovers(self):
        child = self.launch("recover", LIFETIME="1.2")
        self.assertEqual(child.wait(timeout=4), 0)
        self.assertEqual(self.count(), 2)
        self.assertIn("deadline disarmed", self.logs())

    def test_conformance_failure_is_not_retried_or_admitted(self):
        child = self.launch("exit")
        self.assertEqual(child.wait(timeout=3), 7)
        self.assertEqual(self.count(), 1)
        self.assertNotIn("deadline disarmed", self.logs())

    def test_early_zero_exit_fails_closed(self):
        child = self.launch("exit", EXIT_CODE="0")
        self.assertEqual(child.wait(timeout=3), 1)

    def test_http_503_does_not_admit(self):
        child = self.launch("unhealthy", BUZZ_STARTUP_ATTEMPTS="1")
        self.assertEqual(child.wait(timeout=3), 1)
        self.assertNotIn("deadline disarmed", self.logs())

    def test_http_connection_without_response_is_bounded(self):
        child = self.launch("blackhole", BUZZ_STARTUP_ATTEMPTS="1")
        self.assertEqual(child.wait(timeout=3), 1)
        self.assertIn("timed out", self.logs())

    def test_trickled_http_status_cannot_extend_deadline(self):
        child = self.launch("trickle", BUZZ_STARTUP_ATTEMPTS="1")
        self.assertEqual(child.wait(timeout=3), 1)
        self.assertNotIn("deadline disarmed", self.logs())

    def test_signal_during_startup_does_not_retry(self):
        child = self.launch("hang", BUZZ_STARTUP_TIMEOUT_SECONDS="10")
        deadline = time.monotonic() + 3
        while not (self.root / "count").exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertTrue((self.root / "count").exists())
        child.terminate()
        self.assertEqual(child.wait(timeout=3), 143)
        self.assertEqual(self.count(), 1)

    def test_signal_during_healthy_runtime_is_forwarded(self):
        child = self.launch("healthy")
        self.wait_for("deadline disarmed")
        child.send_signal(signal.SIGINT)
        self.assertEqual(child.wait(timeout=3), 130)
        self.assertEqual((self.root / "signal").read_text(), str(signal.SIGINT))
        self.assertEqual(self.count(), 1)

    def test_signal_during_backoff_does_not_restart(self):
        child = self.launch("hang", BUZZ_STARTUP_BACKOFF_SECONDS="10")
        self.wait_for("retrying startup in 10s")
        child.terminate()
        self.assertEqual(child.wait(timeout=3), 143)
        self.assertEqual(self.count(), 1)

    def test_invalid_configuration_never_launches_relay(self):
        for value in ("0", "-1", "nan", "inf", "text"):
            with self.subTest(value=value):
                child = self.launch("hang", BUZZ_STARTUP_TIMEOUT_SECONDS=value)
                self.assertEqual(child.wait(timeout=3), 2)
                self.assertFalse((self.root / "count").exists())

    def test_config_attempts_and_port_bounds(self):
        for key, value in (
            ("BUZZ_STARTUP_ATTEMPTS", "0"),
            ("BUZZ_STARTUP_ATTEMPTS", "11"),
            ("BUZZ_HEALTH_PORT", "0"),
            ("BUZZ_HEALTH_PORT", "65536"),
        ):
            with (
                self.subTest(key=key, value=value),
                patch.dict(os.environ, {key: value}, clear=True),
                self.assertRaises(ValueError),
            ):
                startup.Settings.from_env()


if __name__ == "__main__":
    unittest.main()
