import io
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / 'runtime'))
from memory_archive import restore


class MemoryArchiveTest(unittest.TestCase):
    def archive(self, name='cluster/PG_VERSION'):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w:gz') as archive:
            directory = tarfile.TarInfo('cluster')
            directory.type = tarfile.DIRTYPE
            directory.mode = 0o700
            archive.addfile(directory)
            member = tarfile.TarInfo(name)
            member.size = 2
            member.mode = 0o600
            archive.addfile(member, io.BytesIO(b'18'))
            executable = tarfile.TarInfo('postgres')
            executable.mode = 0o700
            archive.addfile(executable, io.BytesIO())
        stream.seek(0)
        return stream

    def test_restore_preserves_postgresql_compatible_permissions_and_contents(self):
        with tempfile.TemporaryDirectory() as temporary, patch('os.chown') as chown:
            root = Path(temporary)
            previous = os.umask(0o022)
            try:
                restore(self.archive(), root)
            finally:
                os.umask(previous)
            self.assertEqual((root / 'cluster').stat().st_mode & 0o777, 0o700)
            self.assertEqual(root.stat().st_mode & 0o777, 0o700)
            self.assertEqual((root / 'cluster/PG_VERSION').read_bytes(), b'18')
            self.assertEqual((root / 'cluster/PG_VERSION').stat().st_mode & 0o777, 0o600)
            self.assertTrue(os.access(root / 'postgres', os.X_OK))
            chown.assert_any_call(root / 'cluster', 1000, 1000, follow_symlinks=False)
            with self.assertRaisesRegex(ValueError, 'empty destination'):
                restore(self.archive(), root)

    def test_restore_rejects_archive_traversal(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'volume'
            root.mkdir()
            with self.assertRaises(tarfile.OutsideDestinationError):
                restore(self.archive('../outside'), root)
            self.assertFalse((root.parent / 'outside').exists())
