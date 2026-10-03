"""Release safety tests use synthetic layers and responses; never paid inference."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import publish
import scan_layers


class PublicationTests(unittest.TestCase):
    def test_release_needs_no_subscription_credentials(self):
        workflow = (Path(__file__).resolve().parents[2] /
                    '.github/workflows/hermes-promote.yml').read_text()
        self.assertNotIn('HERMES_SUBSCRIPTION_AUTH_JSON', workflow)
        self.assertNotIn('--subscription', workflow)
        self.assertIn('scripts/hermes-release/publish.py preflight', workflow)
        self.assertIn('scripts/hermes-release/scan_layers.py', workflow)
        self.assertIn('apps/agent-box/test/smoke.py hermes-release:local', workflow)
        self.assertIn('scripts/hermes-release/publish.py publish', workflow)

    def test_package_metadata_uses_hexorx_user_namespace(self):
        with patch.object(publish.subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 0, b'{"visibility":"private"}')) as run:
            publish.package_state()
        self.assertEqual(run.call_args.args[0],
                         ['gh', 'api', 'users/hexorx/packages/container/agent-box-hermes'])

    def test_existing_tag_and_nonprivate_package_refuse_before_push(self):
        sha = 'a' * 40
        with patch.object(publish, 'package_state', return_value={'visibility': 'private'}), \
             patch.object(publish, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(
                 [[{'metadata': {'container': {'tags': ['sha-' + sha]}}}]]).encode())):
            with self.assertRaisesRegex(ValueError, 'already exists'):
                publish.preflight(sha)
        for visibility in ('public', 'internal'):
            with patch.object(publish.subprocess, 'run', return_value=subprocess.CompletedProcess(
                    [], 0, json.dumps({'visibility': visibility}).encode())):
                with self.assertRaisesRegex(ValueError, 'non-private'):
                    publish.package_state()

    def test_only_404_allows_new_private_package(self):
        with patch.object(publish.subprocess, 'run', return_value=subprocess.CompletedProcess(
                [], 1, b'', b'gh: Not Found (HTTP 404)')):
            self.assertIsNone(publish.package_state(allow_missing=True))
            with self.assertRaises(ValueError):
                publish.package_state()
        for error in (b'Forbidden (HTTP 403)', b'Unauthorized (HTTP 401)', b'connection refused'):
            with patch.object(publish.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, b'', error)):
                with self.assertRaises(ValueError):
                    publish.package_state(allow_missing=True)

    def test_preserve_digest_and_verify_remote_before_success_receipt(self):
        with tempfile.TemporaryDirectory() as tmp:
            receipt = Path(tmp) / 'receipt.json'
            sha = 'a' * 40
            with patch.object(publish, 'preflight', return_value='sha-' + sha), \
                 patch.object(publish, 'package_state'), patch.dict(os.environ, {'REGISTRY_AUTH_FILE': '/private/auth'}), \
                 patch.object(publish, 'run', side_effect=[
                     subprocess.CompletedProcess([], 0, b'manifest'),
                     subprocess.CompletedProcess([], 0, b''),
                     subprocess.CompletedProcess([], 0, b'different-manifest')]) as run:
                with self.assertRaisesRegex(ValueError, 'digest mismatch'):
                    publish.publish(sha, Path('image.oci.tar'), receipt)
                self.assertIn('--preserve-digests', run.call_args_list[1].args[0])
                self.assertEqual(json.loads(receipt.read_text())['status'], 'prepared')


class SecretTests(unittest.TestCase):
    def test_allowlist_matches_bytes_rule_path_and_line_not_only_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / 'fixture.txt'
            path.write_text('not-a-real-secret')
            row = {'path': '/fixture.txt', 'file_sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                   'rule_id': 'fixture', 'lines': [1]}
            report = {'SchemaVersion': 2, 'Results': [{'Target': 'fixture.txt', 'Secrets': [
                {'RuleID': 'fixture', 'StartLine': 1, 'Match': 'never-emit-this-value'}]}]}
            with patch.object(scan_layers.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(report).encode())):
                self.assertEqual(scan_layers.scan(root, [row]), [])
                path.write_text('changed')
                findings = scan_layers.scan(root, [row])
                self.assertEqual(len(findings), 1)
                self.assertNotIn('never-emit', json.dumps(findings))
                self.assertNotIn('changed', json.dumps(findings))

    def test_deleted_file_is_scanned_in_earlier_layer(self):
        def tar_bytes(files):
            result = io.BytesIO()
            with tarfile.open(fileobj=result, mode='w') as tar:
                for name, data in files.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    tar.addfile(member, io.BytesIO(data))
            return result.getvalue()
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            image = root / 'image.tar'
            image.write_bytes(tar_bytes({
                'manifest.json': json.dumps([{'Config': 'config.json', 'Layers': ['first.tar', 'second.tar']}]).encode(),
                'config.json': b'{}', 'first.tar': tar_bytes({'secret.txt': b'fixture'}),
                'second.tar': tar_bytes({'.wh.secret.txt': b''}),
            }))
            seen = []
            def scan(directory, allowlist):
                seen.append(sorted(p.name for p in directory.iterdir()))
                return [{'path': '/secret.txt', 'rule': 'fixture', 'line': 1}] if (directory / 'secret.txt').exists() else []
            with patch.object(scan_layers, 'scan', side_effect=scan), patch.dict(os.environ, {'RUNNER_TEMP': tmp}):
                with self.assertRaisesRegex(ValueError, 'Secret scan failed'):
                    scan_layers.check(image, root / 'report.json')
            self.assertEqual(seen, [['config.json'], ['secret.txt'], ['.wh.secret.txt']])
            self.assertEqual(len(json.loads((root / 'report.json').read_text())['surfaces']), 3)

    def test_scanner_errors_and_unsafe_paths_fail_closed(self):
        for path in ('/outside', '../outside', 'a/../../outside'):
            with self.assertRaises(ValueError):
                scan_layers.safe_name(path)
        with patch.object(scan_layers.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, ['trivy'])):
            with self.assertRaises(subprocess.CalledProcessError):
                scan_layers.scan(Path('.'), [])


if __name__ == '__main__':
    unittest.main()
