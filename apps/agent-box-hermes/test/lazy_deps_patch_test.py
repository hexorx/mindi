"""Regression coverage for the computer-use lazy dependency security pin."""
from pathlib import Path
import sys
import tempfile
import tomllib
import unittest

BUILD = Path(__file__).parents[1] / 'build'
sys.path.insert(0, str(BUILD))
import patch_lazy_deps


class LazyDepsPatchTest(unittest.TestCase):
    def test_updates_only_the_stale_pin_and_matches_project(self):
        source = 'LAZY_DEPS = {"tool.computer_use": (\n    "mcp==2.0.0",\n    ' + patch_lazy_deps.OLD + '\n    "starlette==1.3.1",\n)}\n'
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'lazy_deps.py'
            path.write_text(source)
            patch_lazy_deps.patch(path)
            namespace = {}
            exec(path.read_text(), namespace)
            project = tomllib.loads((BUILD / 'hermes-pyproject.toml').read_text())
            self.assertEqual(list(namespace['LAZY_DEPS']['tool.computer_use']),
                             project['project']['optional-dependencies']['computer-use'])
            self.assertEqual(path.read_text(), source.replace('httpx2==2.7.0', 'httpx2==2.12.0'))

    def test_rejects_changed_or_duplicate_upstream_without_writing(self):
        for source in ['', patch_lazy_deps.NEW, patch_lazy_deps.OLD * 2]:
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                path = Path(temporary) / 'lazy_deps.py'
                path.write_text(source)
                with self.assertRaises(ValueError):
                    patch_lazy_deps.patch(path)
                self.assertEqual(path.read_text(), source)
