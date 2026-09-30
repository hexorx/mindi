"""Behavioral policy checks; fixtures contain no upstream proprietary bytes."""
import bz2
import gzip
import hashlib
import io
import json
import lzma
import os
import re
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
from collect_debian_notices import collect  # noqa: E402
from verify_payloads import inspect_docker_save, inspect_root, inspect_stream  # noqa: E402


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

    def test_scanner_rejects_compressed_npm_cache_by_magic(self):
        import gzip
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w') as t:
            member = tarfile.TarInfo('package/dist/renamed.js')
            member.size = len(self.payload)
            t.addfile(member, io.BytesIO(self.payload))
        data = io.BytesIO(gzip.compress(archive.getvalue()))
        with self.assertRaisesRegex(ValueError, 'forbidden payload hash'):
            inspect_stream(data, '.npm/_cacache/content-v2/opaque', self.policy)

    def test_compressed_and_extensionless_tar_members_fail_root_and_layers(self):
        import bz2
        import lzma
        data = io.BytesIO()
        with tarfile.open(fileobj=data, mode='w') as t:
            member = tarfile.TarInfo('renamed')
            member.size = len(self.payload)
            t.addfile(member, io.BytesIO(self.payload))
        formats = {'cache.tar.xz': lzma.compress(data.getvalue()),
                   'cache.tar.bz2': bz2.compress(data.getvalue()),
                   'opaque-cache': data.getvalue()}
        for name, compressed in formats.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as d:
                root = Path(d) / 'root'
                root.mkdir()
                (root / name).write_bytes(compressed)
                with self.assertRaisesRegex(ValueError, 'forbidden payload hash'):
                    inspect_root(root, self.policy)
                layer = io.BytesIO()
                with tarfile.open(fileobj=layer, mode='w') as t:
                    member = tarfile.TarInfo(name)
                    member.size = len(compressed)
                    t.addfile(member, io.BytesIO(compressed))
                image = Path(d) / 'image.tar'
                with tarfile.open(image, mode='w') as t:
                    for path, content in {
                        'manifest.json': b'[{"Layers":["layer.tar"]}]',
                        'layer.tar': layer.getvalue(),
                    }.items():
                        member = tarfile.TarInfo(path)
                        member.size = len(content)
                        t.addfile(member, io.BytesIO(content))
                with self.assertRaisesRegex(ValueError, 'forbidden payload hash'):
                    inspect_docker_save(image, self.policy)

    def test_compressed_non_tar_content_through_root_and_layers(self):
        nested = io.BytesIO()
        with zipfile.ZipFile(nested, 'w') as archive:
            archive.writestr('renamed', self.payload)
        forbidden_path = io.BytesIO()
        with zipfile.ZipFile(forbidden_path, 'w') as archive:
            archive.writestr('fonts/Collapse-Regular.woff2', b'allowed bytes')
        for compressor in (gzip.compress, bz2.compress, lzma.compress):
            too_deep = b'allowed bytes'
            for _ in range(9):
                too_deep = compressor(too_deep)
            cases = [
                ('allowed', compressor(b'ordinary non-tar content'), None),
                ('denied', compressor(self.payload), 'forbidden payload hash'),
                ('nested-hash', compressor(nested.getvalue()), 'forbidden payload hash'),
                ('nested-path', compressor(forbidden_path.getvalue()), 'forbidden payload path'),
                ('depth', too_deep, 'archive nesting exceeds verification limit'),
                ('unsupported', compressor(b'\x28\xb5\x2f\xfdtest'), 'unsupported archive format'),
            ]
            for case, content, error in cases:
                for mode in ('root', 'docker-save'):
                    with self.subTest(format=compressor.__module__, case=case, mode=mode):
                        with tempfile.TemporaryDirectory() as d:
                            root = Path(d) / 'root'
                            root.mkdir()
                            (root / 'opaque-cache').write_bytes(content)
                            if mode == 'root':
                                scan = lambda: inspect_root(root, self.policy)
                            else:
                                layer = io.BytesIO()
                                with tarfile.open(fileobj=layer, mode='w') as archive:
                                    member = tarfile.TarInfo('opaque-cache')
                                    member.size = len(content)
                                    archive.addfile(member, io.BytesIO(content))
                                image = Path(d) / 'image.tar'
                                with tarfile.open(image, mode='w') as archive:
                                    for name, data in {
                                        'manifest.json': b'[{"Layers":["layer.tar"]}]',
                                        'layer.tar': layer.getvalue(),
                                    }.items():
                                        member = tarfile.TarInfo(name)
                                        member.size = len(data)
                                        archive.addfile(member, io.BytesIO(data))
                                scan = lambda: inspect_docker_save(image, self.policy)
                            if error:
                                with self.assertRaisesRegex(ValueError, error):
                                    scan()
                            else:
                                self.assertEqual(scan()['files'], 1)

    def test_archive_member_paths_are_separate_from_diagnostic_labels(self):
        def tar_bytes(name, content):
            data = io.BytesIO()
            with tarfile.open(fileobj=data, mode='w') as archive:
                member = tarfile.TarInfo(name)
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))
            return data.getvalue()

        for member_name in ('Collapse-Regular.woff2', 'fonts/Collapse-Regular.woff2',
                            './Collapse-Regular.woff2', 'allowed.woff2'):
            # Harmless bytes ensure filename checks, not hash checks, decide.
            payload = b'allowed bytes'
            zipped = io.BytesIO()
            with zipfile.ZipFile(zipped, 'w') as archive:
                archive.writestr(member_name, payload)
            formats = {'zip': zipped.getvalue(), 'tar': tar_bytes(member_name, payload)}
            for kind, data in list(formats.items()):
                for compressor in (gzip.compress, bz2.compress, lzma.compress):
                    formats[kind + '-' + compressor.__module__] = compressor(data)
            formats['direct'] = payload
            for kind, content in formats.items():
                for mode in ('root', 'docker-save'):
                    with self.subTest(member=member_name, kind=kind, mode=mode):
                        with tempfile.TemporaryDirectory() as d:
                            root = Path(d) / 'root'
                            root.mkdir()
                            name = member_name if kind == 'direct' else 'opaque-cache'
                            path = root / name
                            path.parent.mkdir(parents=True, exist_ok=True)
                            path.write_bytes(content)
                            if mode == 'root':
                                scan = lambda: inspect_root(root, self.policy)
                            else:
                                image = Path(d) / 'image.tar'
                                with tarfile.open(image, 'w') as archive:
                                    for entry, data in {
                                        'manifest.json': b'[{"Layers":["layer.tar"]}]',
                                        'layer.tar': tar_bytes(name, content),
                                    }.items():
                                        member = tarfile.TarInfo(entry)
                                        member.size = len(data)
                                        archive.addfile(member, io.BytesIO(data))
                                scan = lambda: inspect_docker_save(image, self.policy)
                            if member_name == 'allowed.woff2':
                                self.assertEqual(scan()['files'], 1)
                            else:
                                with self.assertRaisesRegex(ValueError, 'forbidden payload path') as error:
                                    scan()
                                self.assertIn('Collapse-Regular.woff2', str(error.exception))
                                if kind != 'direct':
                                    self.assertIn('opaque-cache!', str(error.exception))
                                if mode == 'docker-save':
                                    self.assertIn('layer.tar:', str(error.exception))

    def test_docs_prefix_never_exempts_payloads_in_root_or_layers(self):
        def packed(entries, kind):
            data = io.BytesIO()
            if kind == 'zip':
                with zipfile.ZipFile(data, 'w') as archive:
                    for name, content in entries.items():
                        archive.writestr(name, content)
            else:
                with tarfile.open(fileobj=data, mode='w') as archive:
                    for name, content in entries.items():
                        member = tarfile.TarInfo(name)
                        member.size = len(content)
                        archive.addfile(member, io.BytesIO(content))
            return data.getvalue()

        docs = 'usr/share/doc/agent-box-hermes/'
        notice = b'Historical notice: Collapse-Regular.woff2; @photon-ai/whatsapp-business/; claude_agent_sdk/_bundled/claude'
        cases = [
            (suffix, b'harmless synthetic bytes', 'forbidden payload path')
            for suffix in ('Collapse-Regular.woff2',
                           'node_modules/@photon-ai/whatsapp-business/index.js',
                           'claude_agent_sdk/_bundled/claude',
                           'chrome-headless-shell-linux64/chrome-headless-shell')
        ] + [('third-party/NOTICE.txt', notice, None),
             ('third-party/provenance.json', b'{"excluded":"Collapse-Regular.woff2"}', None),
             ('third-party/NOTICE.txt', self.payload, 'forbidden payload hash')]
        for prefix in (docs, 'invented/' + docs):
            for suffix, content, error in cases:
                entries = {prefix + suffix: content}
                variants = {'direct': entries,
                            'zip': {'cache.zip': packed(entries, 'zip')},
                            'tar': {'cache.tar': packed(entries, 'tar')},
                            'nested': {docs + 'evidence.gz': gzip.compress(packed(
                                {docs + 'inner.zip': packed(entries, 'zip')}, 'tar'))}}
                for kind, files in variants.items():
                    for mode in ('root', 'docker-save'):
                        with self.subTest(prefix=prefix, suffix=suffix, error=error,
                                          kind=kind, mode=mode), tempfile.TemporaryDirectory() as d:
                            root = Path(d) / 'root'
                            root.mkdir()
                            for name, data in files.items():
                                path = root / name
                                path.parent.mkdir(parents=True, exist_ok=True)
                                path.write_bytes(data)
                            if mode == 'root':
                                scan = lambda: inspect_root(root, self.policy)
                            else:
                                image = Path(d) / 'image.tar'
                                image.write_bytes(packed({
                                    'manifest.json': b'[{"Layers":["layer.tar"]}]',
                                    'layer.tar': packed(files, 'tar'),
                                }, 'tar'))
                                before = image.read_bytes()
                                scan = lambda: inspect_docker_save(image, self.policy)
                            if error:
                                with self.assertRaisesRegex(ValueError, error):
                                    scan()
                            else:
                                self.assertEqual(scan()['files'], 1)
                            for name, data in files.items():
                                self.assertEqual((root / name).read_bytes(), data)
                            if mode == 'docker-save':
                                self.assertEqual(image.read_bytes(), before)

    def test_recognized_unsupported_archive_fails_closed(self):
        with self.assertRaisesRegex(ValueError, 'unsupported archive format'):
            inspect_stream(io.BytesIO(b'\x28\xb5\x2f\xfdtest'), 'cache.zst', self.policy)

    def test_root_scanner_checks_links_without_following_them(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / 'allowed').symlink_to('/usr/bin/ffmpeg')
            self.assertEqual(inspect_root(root, self.policy)['files'], 0)
            (root / 'forbidden').symlink_to('/opt/fonts/Collapse-Regular.woff2')
            with self.assertRaisesRegex(ValueError, 'forbidden payload link'):
                inspect_root(root, self.policy)

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
            put('root/.npm/_npx/test/node_modules/playwright-core/package.json',
                b'{"name":"playwright-core","version":"1.62.1"}')
            put('root/.npm/_npx/test/node_modules/playwright-core/index.js', b'allowed runtime library')
            claude = put('opt/hindsight/lib/site-packages/claude_agent_sdk/_bundled/claude', b'excluded executable')
            notice = put('usr/share/doc/agent-box-hermes/third-party/notice.txt', b'unchanged notice')
            policy = {'sha256': {hashlib.sha256(self.payload).hexdigest(): 'font:Collapse-Regular.woff2'}}
            report = sanitize(root, policy)
            self.assertEqual(len(report['removed']), 3)
            self.assertFalse(cache.exists())
            self.assertFalse((root / 'root/.npm').exists())
            self.assertEqual((root / 'opt/agent-box/playwright-core/index.js').read_bytes(),
                             b'allowed runtime library')
            self.assertFalse(claude.exists())
            self.assertFalse((root / sidecar / '@photon-ai/whatsapp-business').exists())
            self.assertIn('system-ui', css.read_text())
            self.assertEqual(notice.read_bytes(), b'unchanged notice')
            link = root / 'opt/hermes/.playwright/ffmpeg-1011/ffmpeg-linux'
            self.assertEqual(os.readlink(link), '/usr/bin/ffmpeg')
            self.assertIn('disabled', (root / wrapper / 'dist/index.js').read_text())

    def sanitizer_fixture(self, root):
        sidecar = root / 'opt/hermes/plugins/platforms/photon/sidecar/node_modules'
        payloads = {
            sidecar / '@spectrum-ts/whatsapp-business/package.json': b'{"version":"8.0.0"}',
            sidecar / '@spectrum-ts/whatsapp-business/dist/index.js':
                b'import {x} from "@photon-ai/whatsapp-business";',
            sidecar / '@photon-ai/whatsapp-business/package.json': b'{"version":"0.1.1"}',
            root / 'root/.npm/_npx/test/node_modules/playwright-core/package.json':
                b'{"version":"1.62.1"}',
            root / 'opt/hermes/font.woff2': self.payload,
            root / 'opt/hermes/app.css': b'body{font-family:"Collapse"}',
        }
        for path, content in payloads.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        return {'sha256': {hashlib.sha256(self.payload).hexdigest(): 'font:test'}}

    def test_html_dynamic_font_removal_preserves_startup(self):
        # Minimal pinned-template shape, no font bytes or network needed.
        html = '''<style>
@font-face {font-family: "Mondwest";src:url("https://esm.sh/@nous-research/ui@0.4.0/dist/fonts/Mondwest-Regular.woff2")}
@font-face {font-family: "Allowed";src:url("allowed.woff2")}
.primer {font:400 26px "Mondwest",serif}
:root {--font-mondwest:system-ui,sans-serif}
</style><canvas id="orbCanvas"></canvas><script>
const DS_CDN = "https://esm.sh/@nous-research/ui@0.4.0/dist/fonts";
const FACES = [new FontFace("Mondwest", `url(${DS_CDN}/Mondwest-Regular.woff2) format("woff2")`, { weight: "400", display: "block" })];
(async () => {
  const loaded = await Promise.all(FACES.map(f => f.load()));
  for (const f of loaded) document.fonts.add(f);
  await document.fonts.load(BODY_FONT, "Aa");
  await document.fonts.load(ASCII_FONT, "Aa");
  rebuildLayouts();
  fontsReady = true;
  requestAnimationFrame(draw);
})();
</script>'''
        for changed_layout in (False, True):
            with self.subTest(changed_layout=changed_layout), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                policy = self.sanitizer_fixture(root)
                path = root / 'opt/hermes/skills/creative/pretext/templates/donut-orbit.html'
                path.parent.mkdir(parents=True)
                path.write_text(html.replace('const FACES =', 'const FACES=') if changed_layout else html)
                if changed_layout:
                    with self.assertRaisesRegex(ValueError, 'unexpected dynamic font layout:.*donut-orbit.html'):
                        sanitize(root, policy)
                    continue
                report = sanitize(root, policy)
                result = path.read_text()
                self.assertNotIn('Mondwest-Regular.woff2', result)
                self.assertNotIn('DS_CDN', result)
                self.assertNotIn('new FontFace', result)
                self.assertIn('font:400 26px system-ui,serif', result)
                self.assertIn('--font-mondwest:system-ui,sans-serif', result)
                self.assertIn('src:url("allowed.woff2")', result)
                self.assertIn('<canvas id="orbCanvas"></canvas>', result)
                self.assertEqual(report['patched_html'], ['/' + str(path.relative_to(root))])
                self.assertEqual(report['patched_css'], ['/opt/hermes/app.css'])
                # Execute the rewritten script: constructing any FontFace fails,
                # while permitted loads, layout preparation and animation run.
                script = re.search(r'<script>(.*?)</script>', result, re.S)[1]
                harness = '''
const assert = require('node:assert/strict');
let fontsReady = false, rebuilt = false;
const BODY_FONT = '10px monospace', ASCII_FONT = '8px monospace';
const loads = [];
const FontFace = function() { throw Error('unexpected font download'); };
const document = {fonts: {add() { throw Error('unexpected face'); },
  async load(font) { loads.push(font); }}};
function rebuildLayouts() { rebuilt = true; }
function draw() {}
function requestAnimationFrame(callback) {
  assert.equal(callback, draw);
  assert.equal(fontsReady, true);
  assert.equal(rebuilt, true);
  assert.deepEqual(loads, [BODY_FONT, ASCII_FONT]);
  console.log('animation ready');
}
'''
                run = subprocess.run(['node', '-e', harness + script], capture_output=True, text=True)
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(run.stdout.strip(), 'animation ready')

    def test_sanitizer_handles_absent_or_invalid_embedded_content(self):
        maps = [{}, {'sourcesContent': None}, {'sourcesContent': 'not a list'},
                {'sourcesContent': 42}, {'sourcesContent': {'css': '@font-face'}},
                {'sourcesContent': False},
                {'sourcesContent': '@font-face {font-family:Collapse;src:url(Collapse-Regular.woff2)}'},
                [], None, 'not an object', 42,
                {'sections': None}, {'sections': [None, {}, {'map': []}]}]
        for source_map in maps:
            with self.subTest(source_map=source_map), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                policy = self.sanitizer_fixture(root)
                path = root / 'opt/hermes/app.css.map'
                original = json.dumps(source_map).encode('utf-8')
                path.write_bytes(original)
                report = sanitize(root, policy)
                if isinstance(source_map, dict) and source_map.get('sourcesContent') is not None:
                    source_map.pop('sourcesContent')
                    self.assertEqual(json.loads(path.read_bytes()), source_map)
                else:
                    self.assertEqual(path.read_bytes(), original)
                self.assertFalse((root / 'opt/hermes/font.woff2').exists())
                self.assertEqual(report['patched_css'], ['/opt/hermes/app.css'])

    def test_sanitizer_rewrites_embedded_css_in_regular_and_index_maps(self):
        css = '@font-face {font-family:"Collapse";src:url(font.woff2)} body{font-family:"Collapse"}'
        for indexed in (False, True):
            with self.subTest(indexed=indexed), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                policy = self.sanitizer_fixture(root)
                embedded = {'version': 3, 'sourcesContent': [css, None, 42, 'unchanged café'],
                            'mappings': 'AAAA', 'sources': ['app.css']}
                source_map = {'sections': [{'offset': {'line': 0, 'column': 0},
                                            'map': embedded}]} if indexed else embedded
                path = root / 'opt/hermes/app.css.map'
                path.write_text(json.dumps(source_map), encoding='utf-8')
                sanitize(root, policy)
                self.assertFalse((root / 'opt/hermes/font.woff2').exists())
                inspect_root(root, self.policy)
                embedded['sourcesContent'][0] = ' body{font-family:system-ui}'
                self.assertEqual(json.loads(path.read_text(encoding='utf-8')), source_map)

    def test_sanitizer_rejects_non_utf8_css_and_maps_with_path(self):
        for suffix in ('.css', '.map', '.html'):
            with self.subTest(suffix=suffix), tempfile.TemporaryDirectory() as d:
                root = Path(d)
                policy = self.sanitizer_fixture(root)
                path = root / ('opt/hermes/invalid' + suffix)
                path.write_bytes(b'\xff invalid UTF-8')
                with self.assertRaises(ValueError) as error:
                    sanitize(root, policy)
                self.assertIn('non-UTF-8 payload:', str(error.exception))
                self.assertIn(str(path), str(error.exception))

    def test_debian_notices_preserve_bytes_and_source_identity(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            notice = root / 'usr/share/doc/chromium/copyright'
            notice.parent.mkdir(parents=True)
            data = b'Upstream and Debian copyright bytes\n'
            notice.write_bytes(data)
            output = root / 'notices'
            records = collect(['chromium'], root, output,
                              lambda _: '154.0\tamd64\tchromium\t154.0\n')
            self.assertEqual((output / 'chromium.copyright').read_bytes(), data)
            self.assertEqual(records[0]['sha256'], hashlib.sha256(data).hexdigest())
            self.assertEqual(records[0]['source_package'], 'chromium')
            with self.assertRaisesRegex(ValueError, 'copyright missing'):
                collect(['missing'], root, output, lambda _: '')

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
