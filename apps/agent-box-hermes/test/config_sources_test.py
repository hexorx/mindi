import base64
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('config_sources', Path(__file__).parents[1] / 'runtime/config_sources.py')
resolver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(resolver)
DEFAULTS = Path(__file__).parents[1] / 'defaults'


class FakeGitHub:
    def __init__(self):
        self.sha = 'a' * 40
        self.calls = []
        self.files = {'agent-box.yaml': b'schemaVersion: 1\nflavor: hermes\nidentity:\n  name: remote\nhermes:\n  model: remote-model\npersona:\n  instructionsFile: persona/AGENTS.md\n',
                      'persona/AGENTS.md': b'Remote persona'}

    def resolve(self, repo, ref):
        self.calls.append(('resolve', repo, ref))
        return self.sha

    def read(self, repo, sha, path, limit):
        self.calls.append(('read', repo, sha, path))
        value = self.files[path]
        if len(value) > limit:
            raise ValueError('oversized')
        return value


class SourceTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.home = Path(self.tmp.name) / 'home'
        self.github = FakeGitHub()

    def apply(self, **kwargs):
        return resolver.apply(self.home, defaults=DEFAULTS, github=self.github, **kwargs)

    def remote(self, **kwargs):
        return self.apply(source='github:user/alice', ref='main', **kwargs)

    def config(self):
        return json.loads((self.home / 'config.yaml').read_text())

    def persona(self):
        return (self.home / 'AGENTS.md').read_text()

    def test_shared_contract_fixtures(self):
        fixtures = json.loads((Path(__file__).parent / 'fixtures/source-settings.json').read_text())
        for data in fixtures['valid']:
            resolver.settings(data)
        for data in fixtures['invalid']:
            with self.assertRaises(ValueError): resolver.settings(data)

    def test_no_github_boot_is_private_and_single_profile(self):
        status = self.apply()
        self.assertEqual(status['source'], 'defaults')
        self.assertEqual(status['state'], 'ready')
        self.assertEqual(self.github.calls, [])
        self.assertEqual(self.config()['toolsets'], ['computer_use'])
        self.assertTrue(self.persona())
        self.assertEqual((self.home / 'config.yaml').stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.home / 'profiles').exists())
        self.assertEqual(self.apply()['contentHash'], status['contentHash'])

    def test_user_org_repo_fixtures_and_pin_reused_until_refresh(self):
        for source, repo in [('github:user/alice', 'alice/alice'), ('github:org/team', 'team/.github'),
                             ('github:repo/team/settings', 'team/settings')]:
            with self.subTest(source=source):
                status = self.apply(source=source, ref='main')
                self.assertEqual(status['commit'], 'a' * 40)
                self.assertEqual(self.github.calls[-1][1], repo)
                self.assertEqual(self.config()['model'], 'remote-model')
                self.assertEqual(self.persona(), 'Remote persona')
                count = len(self.github.calls)
                self.github.sha = 'b' * 40
                self.assertEqual(self.apply(source=source, ref='main')['commit'], 'a' * 40)
                self.assertEqual(len(self.github.calls), count)
                self.assertEqual(self.apply(source=source, ref='main', refresh=True)['commit'], 'b' * 40)
                self.github.sha = 'a' * 40

    def test_invalid_source_and_offline_fallback_required_failure(self):
        status = self.apply(source='https://evil.invalid/token', ref='main')
        self.assertEqual(status['state'], 'degraded')
        self.assertEqual(status['source'], 'defaults')
        self.remote()
        self.github.read = lambda *args: (_ for _ in ()).throw(OSError('secret-in-exception'))
        status = self.remote(refresh=True)
        self.assertEqual(status['state'], 'degraded')
        self.assertEqual(status['source'], 'github:user/alice')
        self.assertEqual(self.persona(), 'Remote persona')
        self.assertNotIn('secret-in-exception', json.dumps(status))
        current = os.readlink(self.home / '.agent-box/current')
        with self.assertRaisesRegex(ValueError, 'Required config source unavailable'):
            self.remote(refresh=True, required=True)
        self.assertEqual(os.readlink(self.home / '.agent-box/current'), current)
        with self.assertRaises(ValueError): self.apply(required=True)

    def test_refresh_validates_every_file_before_activation_and_rollback(self):
        first = self.remote()
        self.github.sha = 'b' * 40
        self.github.files['agent-box.yaml'] = b'schemaVersion: 1\nflavor: hermes\nhermes:\n  model: new-model\npersona:\n  instructionsFile: missing.md\n'
        self.assertEqual(self.remote(refresh=True)['contentHash'], first['contentHash'])
        self.assertEqual(self.config()['model'], 'remote-model')
        self.github.files['missing.md'] = b'New persona'
        self.remote(refresh=True)
        self.assertEqual(self.config()['model'], 'new-model')
        self.assertEqual(self.persona(), 'New persona')
        current = os.readlink(self.home / '.agent-box/current')
        self.github.files['agent-box.yaml'] = b'invalid'
        self.remote(refresh=True)
        self.assertEqual(os.readlink(self.home / '.agent-box/current'), current)
        self.apply(rollback=True)
        self.assertEqual(self.config()['model'], 'remote-model')
        self.assertEqual(self.persona(), 'Remote persona')

    def test_activation_failure_leaves_old_revision(self):
        first = self.remote()
        current = os.readlink(self.home / '.agent-box/current')
        self.github.files['persona/AGENTS.md'] = b'new'
        with patch.object(resolver, 'activate', side_effect=OSError('disk failure')):
            with self.assertRaises(OSError): self.remote(refresh=True)
        self.assertEqual(os.readlink(self.home / '.agent-box/current'), current)
        self.assertEqual(self.persona(), 'Remote persona')
        self.assertEqual(json.loads((self.home / '.agent-box/current/status.json').read_text()), first)

    def test_local_mount_precedence_security_and_source_removal(self):
        local = Path(self.tmp.name) / 'local'
        local.mkdir()
        (local / 'agent-box.yaml').write_text('schemaVersion: 1\nflavor: hermes\nhermes:\n  model: local-model\npersona:\n  instructionsFile: AGENTS.md\n')
        (local / 'AGENTS.md').write_text('Local persona')
        self.remote(local=local)
        self.assertEqual(self.config()['model'], 'local-model')
        self.assertEqual(self.persona(), 'Local persona')
        self.apply()
        self.assertNotIn('model', self.config())
        self.assertNotEqual(self.persona(), 'Remote persona')
        (local / 'AGENTS.md').unlink()
        (local / 'AGENTS.md').symlink_to(DEFAULTS / 'persona/AGENTS.md')
        with self.assertRaises(ValueError): self.remote(local=local)

    def test_legacy_operator_config_is_preserved(self):
        self.home.mkdir()
        (self.home / 'config.yaml').write_text(json.dumps({'model': 'operator', 'security': {'example': True}}))
        (self.home / 'AGENTS.md').write_text('Operator persona')
        self.remote()
        self.assertEqual(self.config()['model'], 'operator')
        self.assertEqual(self.config()['security'], {'example': True})
        self.assertEqual(self.persona(), 'Operator persona')
        self.remote(refresh=True)
        self.assertEqual(self.config()['model'], 'operator')

    def test_rejects_hooks_secrets_traversal_duplicates_aliases_tags_and_size(self):
        invalid = [b'schemaVersion: 1\nflavor: hermes\nhooks: {boot: touch /tmp/pwned}',
                   b'schemaVersion: 1\nflavor: hermes\nnetwork: {tailscale: true}',
                   b'schemaVersion: 1\nflavor: hermes\nhermes: {model: x, apiKey: secret}',
                   b'schemaVersion: 1\nflavor: hermes\npersona: {instructionsFile: ../bad}',
                   b'schemaVersion: 1\nflavor: hermes\npersona: {instructionsFile: %2e%2e/bad}',
                   b'schemaVersion: 1\nschemaVersion: 1\nflavor: hermes',
                   b'schemaVersion: 1\nflavor: hermes\nidentity: &a {name: x}',
                   b'!!python/object/apply:os.system [touch /tmp/pwned]',
                   b'x' * (resolver.MANIFEST_LIMIT + 1)]
        for raw in invalid:
            with self.subTest(raw=raw[:100]):
                self.github.files['agent-box.yaml'] = raw
                self.assertEqual(self.remote(refresh=True)['state'], 'degraded')
        self.github = FakeGitHub()
        self.github.files['persona/AGENTS.md'] = b'x' * (resolver.PERSONA_LIMIT + 1)
        self.assertEqual(self.remote(refresh=True)['state'], 'degraded')

    def test_unmanaged_symlinks_and_extra_profiles_rejected(self):
        self.home.mkdir()
        (self.home / 'config.yaml').symlink_to(Path(self.tmp.name) / 'escape')
        with self.assertRaises(ValueError): self.apply()
        (self.home / 'config.yaml').unlink()
        (self.home / 'profiles/other').mkdir(parents=True)
        with self.assertRaises(ValueError): self.apply()


class TransportTest(unittest.TestCase):
    def test_pins_and_encoded_branch_resolution(self):
        github = resolver.GitHub()
        with patch.object(github, 'request', return_value={'sha': 'c' * 40}) as request:
            self.assertEqual(github.resolve('org/repo', 'a' * 40), 'a' * 40)
            request.assert_not_called()
            self.assertEqual(github.resolve('org/repo', 'feature/config'), 'c' * 40)
            request.assert_called_once_with('org/repo/commits/feature%2Fconfig')
        with self.assertRaises(ValueError): github.resolve('org/repo', 'main?secret')

    def test_regular_bounded_files_only(self):
        github = resolver.GitHub()
        good = {'mode': '100644', 'type': 'blob', 'size': 4, 'path': 'a.md', 'sha': 'c' * 40}
        blob = {'size': 4, 'encoding': 'base64', 'content': base64.b64encode(b'test').decode()}
        def response(entry, data):
            return [{'tree': {'sha': 'b' * 40}}, {'tree': [entry], 'truncated': False}, data]
        with patch.object(github, 'request', side_effect=response(good, blob)):
            self.assertEqual(github.read('org/repo', 'a' * 40, 'a.md', 4), b'test')
        for bad in [{**good, 'mode': '120000'}, {**good, 'mode': '100755'},
                    {**good, 'mode': '160000'}, {**good, 'type': 'symlink'}, {**good, 'size': 5}]:
            github.trees.clear()
            with patch.object(github, 'request', side_effect=response(bad, blob)):
                with self.assertRaises(ValueError): github.read('org/repo', 'a' * 40, 'a.md', 4)
        for bad in [{**blob, 'encoding': 'none'}, {**blob, 'size': 3}]:
            github.trees.clear()
            with patch.object(github, 'request', side_effect=response(good, bad)):
                with self.assertRaises(ValueError): github.read('org/repo', 'a' * 40, 'a.md', 4)
        with self.assertRaises(ValueError):
            resolver.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://evil.invalid')

    def test_only_data_allowlist_is_downloaded(self):
        github = FakeGitHub()
        resolver.bundle(lambda name, limit: github.read('org/repo', 'a' * 40, name, limit), 'agent-box.yaml')
        self.assertEqual([call[-1] for call in github.calls], ['agent-box.yaml', 'persona/AGENTS.md'])


if __name__ == '__main__':
    unittest.main()
