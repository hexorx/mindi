"""Behavioral policy checks; fixtures contain no upstream proprietary bytes."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

APP = Path(__file__).resolve().parents[1]
BUILD = APP / 'build'
sys.path.insert(0, str(BUILD))
from sanitize_payloads import DISABLED_PROVIDER, sanitize, system_font_css  # noqa: E402
from verify_payloads import inspect_docker_save, inspect_stream  # noqa: E402


class PayloadRemediationTest(unittest.TestCase):
    def setUp(self):
        self.payload = b'forbidden test payload'
        self.policy = {'sha256': {hashlib.sha256(self.payload).hexdigest(): 'test'},
                       'font_names': ['Collapse-Regular.woff2']}

    def test_system_fonts_replace_source_and_minified_css(self):
        source = '''@font-face {font-family: 'Collapse';src:url('../fonts/Collapse-Regular.woff2')}
@font-face {font-family: 'Allowed';src:url('allowed.woff2')}
:root {--font-sans: 'Collapse',sans-serif;--font-mondwest:Mondwest,sans-serif}
body {font-family:"Rules Expanded",sans-serif}'''
        result = system_font_css(source)
        self.assertNotIn('Collapse', result)
        self.assertNotIn('Mondwest', result)
        self.assertNotIn('Rules Expanded', result)
        self.assertNotIn('Collapse-Regular.woff2', result)
        self.assertIn("font-family: 'Allowed'", result)
        self.assertEqual(result.count('system-ui'), 3)
        self.assertEqual(system_font_css(result), result)

    def test_scanner_rejects_renamed_payload(self):
        with self.assertRaisesRegex(ValueError, 'forbidden payload hash'):
            inspect_stream(io.BytesIO(self.payload), 'arbitrary-name', self.policy)

    def test_scanner_rejects_compressed_cached_wheel(self):
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w', zipfile.ZIP_DEFLATED) as z:
            z.writestr('renamed-binary', self.payload)
        data.seek(0)
        with self.assertRaisesRegex(ValueError, 'forbidden payload hash'):
            inspect_stream(data, 'cache.whl', self.policy)

    def test_scanner_allows_historical_metadata(self):
        inspect_stream(io.BytesIO(b'{"excluded":"Collapse-Regular.woff2"}'),
                       'usr/share/doc/agent-box-hermes/third-party/policy.json', self.policy)

    def test_whatsapp_disabled_provider_can_be_imported_but_not_used(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'disabled.mjs'
            path.write_text(DISABLED_PROVIDER)
            script = f'''import {{whatsappBusiness}} from {json.dumps(path.as_uri())};
for (const use of [() => whatsappBusiness(), () => whatsappBusiness.config({{}})]) {{
  try {{ use(); process.exit(1); }} catch (e) {{
    if (!e.message.includes('WhatsApp Business is disabled')) throw e;
  }}
}}'''
            subprocess.run(['node', '--input-type=module', '-e', script], check=True)

    def test_claude_missing_and_operator_install(self):
        with tempfile.TemporaryDirectory() as d:
            cli = Path(d) / 'claude'
            env = {**os.environ, 'AGENT_BOX_CLAUDE_CLI': str(cli)}
            cmd = ['sh', str(APP / 'runtime/claude'), 'hello']
            missing = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual(missing.returncode, 127)
            self.assertIn('Claude Code is not bundled', missing.stderr)
            cli.write_text('#!/bin/sh\nprintf "%s" "$1"\n')
            cli.chmod(0o755)
            found = subprocess.run(cmd, env=env, capture_output=True, text=True)
            self.assertEqual(found.returncode, 0)
            self.assertEqual(found.stdout, 'hello')

    def test_sanitizer_removes_duplicates_and_caches_preserves_notices(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            def put(name, data):
                p = root / name
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
                return p
            sidecar = 'opt/hermes/plugins/platforms/photon/sidecar/node_modules/'
            wrapper = sidecar + '@spectrum-ts/whatsapp-business/'
            put(wrapper + 'package.json', b'{"version":"8.0.0"}')
            put(wrapper + 'dist/index.js', b'import {x} from "@photon-ai/whatsapp-business";')
            put(sidecar + '@photon-ai/whatsapp-business/package.json', b'{"version":"0.1.1"}')
            put('opt/hermes/ui/src/fonts/Collapse-Regular.woff2', self.payload)
            put('opt/hermes/hermes_cli/web_dist/assets/renamed.woff2', self.payload)
            css = put('opt/hermes/hermes_cli/web_dist/assets/app.css',
                      b'@font-face {font-family:Collapse;src:url(renamed.woff2)} :root{--font-sans:Collapse,sans-serif}')
            cache = put('root/.cache/wheels/cached.whl', b'opaque cached bytes')
            claude = put('opt/hindsight/lib/site-packages/claude_agent_sdk/_bundled/claude', b'excluded executable')
            notice = put('usr/share/doc/agent-box-hermes/third-party/notice.txt', b'unchanged notice')
            policy = {'sha256': {hashlib.sha256(self.payload).hexdigest(): 'font:Collapse-Regular.woff2'}}
            report = sanitize(root, policy)
            self.assertEqual(len(report['removed']), 3)
            self.assertFalse(cache.exists())
            self.assertFalse(claude.exists())
            self.assertFalse((root / sidecar / '@photon-ai/whatsapp-business').exists())
            self.assertIn('system-ui', css.read_text())
            self.assertEqual(notice.read_bytes(), b'unchanged notice')
            link = root / 'opt/hermes/.playwright/ffmpeg-1011/ffmpeg-linux'
            self.assertEqual(os.readlink(link), '/usr/bin/ffmpeg')
            self.assertIn('disabled', (root / wrapper / 'dist/index.js').read_text())

    def test_whiteout_does_not_hide_forbidden_prior_layer(self):
        def layer(name, content):
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w') as t:
                member = tarfile.TarInfo(name)
                member.size = len(content)
                t.addfile(member, io.BytesIO(content))
            return data.getvalue()
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'image.tar'
            with tarfile.open(path, 'w') as t:
                for name, data in {
                    'manifest.json': json.dumps([{'Layers': ['old/layer.tar', 'new/layer.tar']}]).encode(),
                    'old/layer.tar': layer('renamed', self.payload),
                    'new/layer.tar': layer('.wh.renamed', b''),
                }.items():
                    member = tarfile.TarInfo(name)
                    member.size = len(data)
                    t.addfile(member, io.BytesIO(data))
            with self.assertRaisesRegex(ValueError, 'forbidden payload hash'):
                inspect_docker_save(path, self.policy)


if __name__ == '__main__':
    unittest.main()
