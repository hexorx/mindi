"""Check that the release acceptance gate fails closed on upgrade failures."""
import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('smoke', Path(__file__).with_name('smoke.py'))
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class LegacySmokeTest(unittest.TestCase):
    def test_embedded_programs_compile(self):
        for program in (smoke.LEGACY_SEED, smoke.LEGACY_VERIFY):
            compile(program, '<container program>', 'exec')

    def test_same_volume_verified_as_hermes_after_desktop_and_restart(self):
        events = []
        with patch.object(smoke, 'run', side_effect=lambda args, **kw: events.append(args)), \
             patch.object(smoke, 'wait_desktop', side_effect=lambda name: events.append(['ready', name])):
            smoke.legacy_home_smoke('image', Path('/fixture/test'), ['docker', 'create', '--name', 'test'])
        seed = next(command for command in events if command[:2] == ['docker', 'run'])
        create = next(command for command in events if command[:2] == ['docker', 'create'])
        self.assertEqual(seed[seed.index('-v') + 1], create[create.index('-v') + 1])
        self.assertIn('--network=none', seed)
        self.assertIn('--network=none', create)
        verifies = [i for i, command in enumerate(events) if command[:2] == ['docker', 'exec']]
        self.assertEqual(len(verifies), 2)
        for index in verifies:
            self.assertEqual(events[index - 1], ['ready', 'test-legacy'])
            self.assertEqual(events[index][3:5], ['--user', 'hermes'])
        self.assertEqual(sum(command[:2] == ['docker', 'restart'] for command in events), 1)

    def test_failed_verification_propagates_and_stops_container(self):
        commands = []

        def run(args, **kwargs):
            commands.append(args)
            if args[:2] == ['docker', 'exec']:
                raise subprocess.CalledProcessError(1, args)

        with patch.object(smoke, 'run', side_effect=run), patch.object(smoke, 'wait_desktop'):
            with self.assertRaises(subprocess.CalledProcessError):
                smoke.legacy_home_smoke('image', Path('/fixture/test'), ['docker', 'create', '--name', 'test'])
        self.assertEqual(commands[-1], ['docker', 'stop', '--time', '20', 'test-legacy'])
        self.assertFalse(any(command[:2] == ['docker', 'restart'] for command in commands))


if __name__ == '__main__':
    unittest.main()
