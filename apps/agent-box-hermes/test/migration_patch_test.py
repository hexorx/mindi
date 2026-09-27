import contextlib
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).parents[1] / 'build'))
import patch_hindsight


class MigrationPatchTest(unittest.TestCase):
    def test_concurrent_statements_require_autocommit_and_restore_transaction(self):
        class Operations:
            active = False
            statements = []

            def get_context(self):
                return self

            @contextlib.contextmanager
            def autocommit_block(self):
                self.active = True
                try:
                    yield
                finally:
                    self.active = False

            def execute(self, sql):
                if 'CONCURRENTLY' in sql:
                    self_test.assertTrue(self.active)
                else:
                    self_test.assertFalse(self.active)
                self.statements.append(sql)

        self_test = self
        source = '''def upgrade():
    schema = 'public'
    op.execute("CREATE TABLE fixture (id int)")
    op.execute("COMMIT")
    op.execute(f"DROP INDEX CONCURRENTLY IF EXISTS {schema}.fixture_idx")
    op.execute(
        f"CREATE INDEX CONCURRENTLY fixture_idx ON {schema}.fixture (id)"
    )
    op.execute("INSERT INTO fixture VALUES (1)")
'''
        op = Operations()
        namespace = {'op': op}
        exec(patch_hindsight.transform(source), namespace)
        namespace['upgrade']()
        self.assertEqual(len(op.statements), 4)
        self.assertFalse(op.active)

    def test_changed_dependency_is_rejected_before_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            name = next(iter(patch_hindsight.FINGERPRINTS))
            path = root / name
            path.write_text('unexpected source')
            with self.assertRaisesRegex(ValueError, 'migration changed'):
                patch_hindsight.patch(root)
            self.assertEqual(path.read_text(), 'unexpected source')
