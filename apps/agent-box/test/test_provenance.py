"""Fail on unrecorded edits to recovered source, keeping the original diff auditable."""
import hashlib
import json
from pathlib import Path
import shlex
import unittest

APP = Path(__file__).resolve().parents[1]


class ProvenanceTest(unittest.TestCase):
    def test_import_matches_original_or_explicit_change_record(self):
        manifest = json.loads((APP / 'source-manifest.json').read_text())
        changes = {r['path']: r for r in json.loads((APP / 'source-changes.json').read_text())}
        changed = set()
        for row in manifest['files']:
            path = row['path']
            actual = hashlib.sha256((APP / path).read_bytes()).hexdigest()
            if path in changes:
                self.assertEqual(changes[path]['original_sha256'], row['sha256'], path)
                self.assertTrue(changes[path]['reason'], path)
                self.assertEqual(actual, changes[path]['imported_sha256'], path)
                changed.add(path)
            else:
                self.assertEqual(actual, row['sha256'], path)
        self.assertEqual(changed, set(changes))

    def test_both_original_recipes_have_all_local_copy_inputs(self):
        for context, recipe in (('base', 'infra/agent-box/Dockerfile'),
                                ('backend', 'infra/backend-box/Dockerfile')):
            source = (APP / context / recipe).read_text().replace('\\\n', ' ')
            for line in source.splitlines():
                if line.startswith('COPY ') and '--from=' not in line:
                    for name in shlex.split(line)[1:-1]:
                        self.assertTrue((APP / context / name).exists(), f'{context}/{name}')


if __name__ == '__main__':
    unittest.main()
