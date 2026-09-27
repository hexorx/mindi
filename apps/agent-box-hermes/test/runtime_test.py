import importlib.util
import json
from pathlib import Path
import tempfile
import runpy
import subprocess
from unittest.mock import patch, MagicMock
import unittest


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parents[1] / "runtime" / (name + ".py"))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class ConfigurationTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.home = Path(self.temp.name) / "hermes"
        self.configure = module("configure").configure

    def test_default_is_idempotent_and_private(self):
        self.configure(self.home)
        path = self.home / "config.yaml"
        first = path.read_bytes()
        self.configure(self.home)
        self.assertEqual(first, path.read_bytes())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(first)["toolsets"], ["computer_use"])
        self.assertFalse((self.home / "profiles").exists())

    def test_preserves_other_configuration(self):
        self.home.mkdir()
        path = self.home / "config.yaml"
        path.write_text(json.dumps({"model": "fixture", "toolsets": ["terminal", "computer_use"],
                                   "computer_use": {"other": 1}}))
        self.configure(self.home)
        result = json.loads(path.read_text())
        self.assertEqual(result["model"], "fixture")
        self.assertEqual(result["toolsets"], ["terminal", "computer_use"])
        self.assertEqual(result["computer_use"], {"other": 1, "grant_existing_profile": True})

    def test_rejects_profiles_symlinks_and_bad_shapes_without_overwrite(self):
        self.home.mkdir()
        path = self.home / "config.yaml"
        for value in [[], {"toolsets": "bad"}, {"computer_use": []}]:
            text = json.dumps(value)
            path.write_text(text)
            with self.assertRaises(ValueError): self.configure(self.home)
            self.assertEqual(path.read_text(), text)
        path.unlink()
        path.symlink_to(self.home / "outside")
        with self.assertRaises(ValueError): self.configure(self.home)
        self.assertFalse((self.home / "outside").exists())
        path.unlink()
        (self.home / "profiles/extra").mkdir(parents=True)
        with self.assertRaises(ValueError): self.configure(self.home)

    def test_password_validation_and_hashing(self):
        secret = Path(self.temp.name) / "secret"
        for value in [b"short", b"a" * 16 + b"\nextra", b"a" * 257, b"a" * 16 + b"\0"]:
            secret.write_bytes(value)
            with self.assertRaises(ValueError): module("bootstrap").password_hash(secret)
        secret.write_bytes(b"fixture-only-long-password")
        hashed = module("bootstrap").password_hash(secret)
        self.assertTrue(hashed.startswith(b"$6$"))
        self.assertNotIn(secret.read_bytes(), hashed)


class ReadinessTest(unittest.TestCase):
    def test_memory_failure_blocks_readiness_even_with_healthy_desktop(self):
        health = Path(__file__).parents[1] / "runtime/health.py"
        frame = MagicMock(stdout=b"\x89PNG\r\n\x1a\n" + b"x" * 100)
        with patch("subprocess.run", return_value=frame), \
             patch("socket.create_connection"), \
             patch("urllib.request.urlopen"), \
             patch("json.load", return_value={"status": "unhealthy"}):
            with self.assertRaises(SystemExit) as exit_status:
                runpy.run_path(str(health))
            self.assertEqual(exit_status.exception.code, 1)


    def test_requires_sway_ipc_even_when_frame_and_listeners_work(self):
        health = Path(__file__).parents[1] / "runtime/health.py"
        frame = MagicMock(stdout=b"\x89PNG\r\n\x1a\n" + b"x" * 100)
        with patch("subprocess.run", return_value=frame) as run, \
             patch("socket.create_connection"), \
             patch("urllib.request.urlopen"), \
             patch("json.load", return_value={"status": "healthy"}):
            runpy.run_path(str(health))
            def fail_ipc(args, **kwargs):
                if args[0] == "swaymsg":
                    raise subprocess.CalledProcessError(1, args)
                return frame
            run.side_effect = fail_ipc
            with self.assertRaises(SystemExit) as exit_status:
                runpy.run_path(str(health))
            self.assertEqual(exit_status.exception.code, 1)


if __name__ == "__main__": unittest.main()
