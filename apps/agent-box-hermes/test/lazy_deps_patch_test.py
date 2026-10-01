"""Regression coverage for the computer-use lazy dependency security pin."""
import ast
from pathlib import Path
import sys
import tempfile
import tomllib
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

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


class ReadinessCheckTest(unittest.TestCase):
    def run_readiness_check(self, missing):
        source = ast.parse((BUILD / 'verify_python_security.py').read_text())
        start = next(i for i, node in enumerate(source.body)
                     if isinstance(node, ast.Assign)
                     and any(isinstance(target, ast.Name) and target.id == 'missing'
                             for target in node.targets))
        check = ast.Module(body=source.body[start:-1], type_ignores=[])
        lazy = SimpleNamespace(feature_missing=Mock(return_value=missing),
                               ensure=Mock(), _venv_pip_install=Mock())
        exec(compile(check, '<readiness-check>', 'exec'), {'lazy_deps': lazy, 'patch': patch})
        return lazy

    def test_accepts_upstream_empty_tuple_and_exercises_ensure(self):
        lazy = self.run_readiness_check(())
        lazy.feature_missing.assert_called_once_with('tool.computer_use')
        lazy.ensure.assert_called_once_with('tool.computer_use', prompt=False)
        lazy._venv_pip_install.assert_not_called()

    def test_reports_missing_dependency(self):
        with self.assertRaisesRegex(AssertionError, 'httpx2==2.12.0'):
            self.run_readiness_check(('httpx2==2.12.0',))
