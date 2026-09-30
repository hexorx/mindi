"""Inventory evidence must preserve bytes and expose missing notices."""
import base64
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[3] / 'scripts/release/collect_inventory.py'
spec = importlib.util.spec_from_file_location('collect_inventory', SCRIPT)
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class InventoryTest(unittest.TestCase):
    def test_notice_preserves_exact_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'LICENSE'
            raw = b'Copyright\xff\r\nPermission granted.\n'
            path.write_bytes(raw)
            result = inventory.notice(path, directory)
            self.assertEqual(base64.b64decode(result['content_base64']), raw)
            self.assertEqual(result['sha256'], hashlib.sha256(raw).hexdigest())

    def test_notice_refuses_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'LICENSE'
            path.symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                inventory.notice(path, directory)

    def test_missing_notice_is_explicit(self):
        from email.message import Message
        class Distribution:
            metadata = Message()
            metadata['Name'] = 'example'
            version = '1.0'
            files = []
        self.assertEqual(inventory.python_inventory([Distribution()])[0]['notice_status'], 'missing')

    def test_nested_license_text_is_collected_without_importing_package(self):
        from email.message import Message
        with tempfile.TemporaryDirectory() as directory:
            relative = Path('example-1.0.dist-info/licenses/vendor/BSD.txt')
            path = Path(directory) / relative
            path.parent.mkdir(parents=True)
            path.write_bytes(b'Copyright example\n')
            class Distribution:
                metadata = Message()
                metadata['Name'] = 'example'
                version = '1.0'
                files = [relative, Path('app/private/NOTICE')]
                def locate_file(self, file):
                    return Path(directory) / file
            result = inventory.python_inventory([Distribution()])[0]
            self.assertEqual(len(result['notices']), 1)
            self.assertEqual(result['notice_status'], 'collected_unreviewed')
            self.assertEqual(base64.b64decode(result['notices'][0]['content_base64']),
                             b'Copyright example\n')
