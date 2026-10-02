import json
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).parents[1] / 'runtime'))
import memory


class MemoryTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.home = self.root / 'home/.hermes'
        self.home.mkdir(parents=True)

    def test_identity_and_file_memory_survive_restart_without_any_keys(self):
        memory.configure_builtin(self.home)
        identity = self.home.parent / '.agent-box/identity.json'
        first = identity.read_bytes()
        self.assertEqual(json.loads(first)['schemaVersion'], 1)
        notes = self.home / 'memories/MEMORY.md'
        notes.write_text('Remember this across restart.')
        memory.configure_builtin(self.home)
        self.assertEqual(identity.read_bytes(), first)
        self.assertEqual(notes.read_text(), 'Remember this across restart.')
        self.assertEqual(identity.stat().st_mode & 0o777, 0o600)
        self.assertEqual(notes.parent.stat().st_mode & 0o777, 0o700)
        self.assertFalse((self.home / '.env').exists())

    def test_legacy_database_and_hindsight_settings_are_not_modified(self):
        old = self.home / 'hindsight'
        old.mkdir()
        config = old / 'config.json'
        config.write_text('{"mode":"local_external","bank_id":"old"}')
        memory.configure_builtin(self.home)
        self.assertEqual(config.read_text(), '{"mode":"local_external","bank_id":"old"}')

    def test_symlinked_identity_or_memory_is_refused(self):
        memory.configure_builtin(self.home)
        identity = self.home.parent / '.agent-box/identity.json'
        identity.unlink()
        identity.symlink_to(self.root / 'outside')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            memory.configure_builtin(self.home)
        self.assertFalse((self.root / 'outside').exists())
        identity.unlink()
        (self.home / 'memories').rmdir()
        (self.home / 'memories').symlink_to(self.root)
        with self.assertRaisesRegex(ValueError, 'symlink'):
            memory.configure_builtin(self.home)


if __name__ == '__main__':
    unittest.main()
