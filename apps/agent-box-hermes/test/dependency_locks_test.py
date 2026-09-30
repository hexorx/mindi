"""Fail-closed resolver conversion and exact CPU-only artifact coverage."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('lock_python', ROOT / 'scripts/release/lock_python.py')
lock_python = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lock_python)


def wheel(version='1'):
    return {'metadata': {'name': 'Some_Package', 'version': version},
            'download_info': {'url': f'https://files.pythonhosted.org/some_package-{version}-py3-none-any.whl',
                              'archive_info': {'hashes': {'sha256': 'a' * 64}}}}


def inventory(version='1'):
    return {'installed': [{'metadata': {'name': 'some-package', 'version': version}},
                          {'metadata': {'name': 'pip', 'version': '25.1.1'}}]}


class DependencyLockTest(unittest.TestCase):
    def test_later_report_supersedes_earlier_version(self):
        result = lock_python.render([{'install': [wheel()]}, {'install': [wheel('2')]}], inventory('2'))
        self.assertIn('# some-package==2', result)
        self.assertNotIn('some_package-1-', result)
        self.assertEqual(result.count('--hash=sha256:'), 1)

    def test_missing_extra_or_changed_package_is_rejected(self):
        for installed in [inventory('2'), {'installed': []},
                          {'installed': inventory()['installed'] + [{'metadata': {'name': 'extra', 'version': '1'}}]}]:
            with self.subTest(installed=installed), self.assertRaises(ValueError):
                lock_python.render([{'install': [wheel()]}], installed)

    def test_unverified_or_nonwheel_inputs_are_rejected(self):
        for url in ['http://files.pythonhosted.org/a.whl', 'https://example.com/a.whl',
                    'https://files.pythonhosted.org/a.tar.gz',
                    'https://user:password@files.pythonhosted.org/a.whl',
                    'https://files.pythonhosted.org/a.whl?token=secret']:
            item = wheel()
            item['download_info']['url'] = url
            with self.subTest(url=url), self.assertRaises(ValueError):
                lock_python.render([{'install': [item]}], inventory())
        item = wheel()
        item['download_info']['archive_info']['hashes'] = {'sha1': 'a' * 40}
        with self.assertRaises(ValueError):
            lock_python.render([{'install': [item]}], inventory())

    def test_checked_in_closure_has_only_hashed_wheels_and_cpu_torch(self):
        path = ROOT / 'apps/agent-box-hermes/build/hindsight-linux-amd64.lock'
        lines = [s for s in path.read_text().splitlines() if s and not s.startswith('#')]
        self.assertEqual(len(lines), 214)
        self.assertEqual(len({s.split(' @ ')[0] for s in lines}), 214)
        for line in lines:
            self.assertRegex(line, r'^[a-z0-9-]+ @ https://\S+\.whl --hash=sha256:[a-f0-9]{64}$')
        torch = next(s for s in lines if s.startswith('torch @'))
        self.assertIn('/cpu/torch-2.8.0%2Bcpu-cp313-cp313-', torch)
        self.assertFalse(any(s.startswith('nvidia-') for s in lines))


if __name__ == '__main__':
    unittest.main()
