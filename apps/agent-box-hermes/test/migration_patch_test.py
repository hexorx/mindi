import gzip
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).parents[1] / 'build'))
import patch_hindsight


class MigrationPatchTest(unittest.TestCase):
    def test_reviewed_upstream_migrations_are_verified_without_mutation(self):
        fixtures = Path(__file__).parent / 'fixtures/hindsight-0.8.3'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            originals = {}
            for name in patch_hindsight.FINGERPRINTS:
                originals[name] = gzip.decompress((fixtures / (name + '.gz')).read_bytes())
                (root / name).write_bytes(originals[name])
            patch_hindsight.patch(root)
            self.assertEqual({p.name: p.read_bytes() for p in root.iterdir()}, originals)

    def test_requires_exactly_one_autocommit_block(self):
        statement = 'op.execute("CREATE INDEX CONCURRENTLY fixture_idx ON fixture (id)")'
        block = 'with op.get_context().autocommit_block():\n'
        patch_hindsight.verify_transactions(block + '    ' + statement)
        for source in [statement, 'op.execute("COMMIT")', 'op.execute("SELECT 1")',
                       block + '    ' + block + '        ' + statement]:
            with self.subTest(source=source), self.assertRaises(ValueError):
                patch_hindsight.verify_transactions(source)

    def test_changed_dependency_is_rejected_before_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            name = next(iter(patch_hindsight.FINGERPRINTS))
            path = root / name
            path.write_text('unexpected source')
            with self.assertRaisesRegex(ValueError, 'migration changed'):
                patch_hindsight.patch(root)
            self.assertEqual(path.read_text(), 'unexpected source')
