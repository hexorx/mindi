import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('smoke_result', Path(__file__).parents[1] / 'runtime/smoke_result.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class SmokeResultTest(unittest.TestCase):
    def test_backend_error_without_code_is_actionable(self):
        with self.assertRaisesRegex(RuntimeError, 'capture: unspecified: computer_use backend unavailable: missing mcp'):
            smoke.checked_result('{"error":"computer_use backend unavailable: missing mcp"}', 'capture')

    def test_failure_and_invalid_responses_fail_closed(self):
        for result in ('not json', '[]', {'ok': False}, {'error': {'secret': 'not printable'}}):
            with self.subTest(result=result), self.assertRaises(RuntimeError):
                smoke.checked_result(result, 'capture')

    def test_success_preserves_native_image(self):
        result = {'content': [{'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,fixture'}}]}
        self.assertIs(smoke.checked_result(result, 'capture'), result)

    def test_redacts_environment_files_urls_and_auth_before_truncation(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'API_SERVER_KEY': 'environment-fixture-secret'}):
            root = Path(directory)
            (root / 'desktop_password').write_text('file-fixture-secret\n')
            text = ('environment-fixture-secret file-fixture-secret https://user:pass@example.invalid/?key=value '
                    'Bearer auth-fixture password=inline-fixture\n\x1b[31m ' + 'x' * 790 + 'environment-fixture-secret')
            result = smoke.diagnostic(text, root)
            for secret in ('environment-fixture-secret', 'file-fixture-secret', 'auth-fixture', 'inline-fixture', 'user:pass', '\n', '\x1b'):
                self.assertNotIn(secret, result)
            self.assertLessEqual(len(result), 800)

    def test_private_mount_uses_supplied_fixture_corpus(self):
        with patch.object(Path, 'iterdir', side_effect=PermissionError):
            self.assertEqual(smoke.diagnostic('capture failed'), 'diagnostic_unavailable')
            with self.assertRaisesRegex(RuntimeError, r'capture: unspecified: backend failed: \[redacted\]'):
                smoke.checked_result({'error': 'backend failed: private-fixture'}, 'capture',
                                     secret_values=['private-fixture'])

    def test_invalid_supplied_corpus_fails_closed(self):
        for corpus in ('private-fixture', [None], {'key': 'private-fixture'}):
            self.assertEqual(smoke.diagnostic('private-fixture', secret_values=corpus),
                             'diagnostic_unavailable')

    def test_does_not_include_tool_content_in_failure(self):
        with self.assertRaises(RuntimeError) as failure:
            smoke.checked_result({'error': 'capture failed', 'content': 'private screenshot'}, 'capture')
        self.assertNotIn('private screenshot', str(failure.exception))


if __name__ == '__main__':
    unittest.main()
