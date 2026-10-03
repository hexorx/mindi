"""Regression coverage for image vendor-payload diagnostics."""
import contextlib
import io
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))
import check_unbundled


class CheckUnbundledTest(unittest.TestCase):
    def test_filesystem_failure_prints_all_matches_before_exit(self):
        result = subprocess.CompletedProcess(
            [], 1,
            stdout=(
                'Bundled vendor packages:\n'
                'google-chrome-stable installed\n'
                'Bundled vendor filesystem paths:\n'
                '/opt/mindi-native/node_modules/@anthropic-ai/claude-code\n'
            ),
            stderr='',
        )
        output = io.StringIO()
        with patch.object(check_unbundled.subprocess, 'run', return_value=result):
            with contextlib.redirect_stdout(output):
                with self.assertRaisesRegex(SystemExit, 'bundled vendor payload'):
                    check_unbundled.check_filesystem('test-image')
        self.assertIn('google-chrome-stable installed', output.getvalue())
        self.assertIn('@anthropic-ai/claude-code', output.getvalue())

    def test_layer_failure_reports_every_matching_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            layer = root / 'layer.tar'
            with tarfile.open(layer, 'w') as archive:
                for name in (
                    'opt/mindi-native/node_modules/@anthropic-ai/claude-code/package.json',
                    'usr/bin/google-chrome-stable',
                    'usr/bin/chromium',
                ):
                    info = tarfile.TarInfo(name)
                    info.size = 0
                    archive.addfile(info)
            image = root / 'image.tar'
            manifest = b'[{"Layers":["layer.tar"]}]'
            with tarfile.open(image, 'w') as archive:
                info = tarfile.TarInfo('manifest.json')
                info.size = len(manifest)
                archive.addfile(info, io.BytesIO(manifest))
                archive.add(layer, arcname='layer.tar')
            with self.assertRaises(SystemExit) as raised:
                check_unbundled.check_layers(image)
            message = str(raised.exception)
            self.assertIn('@anthropic-ai/claude-code/package.json', message)
            self.assertIn('usr/bin/google-chrome-stable', message)
            self.assertNotIn('usr/bin/chromium', message)


if __name__ == '__main__':
    unittest.main()
