#!/usr/bin/env python3
"""Apply HEX-193 policy to a disposable image build filesystem, never live data.

The final Docker stage starts FROM scratch and copies this sanitized tree, so
removed bytes are not inherited in distributed layers. Fail on unexpected
upstream layouts instead of silently shipping a partially patched image.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil

POLICY = Path(__file__).with_name('payload-policy.json')
FAMILIES = ('Rules Compressed', 'Rules Expanded', 'PP NeueBit', 'NeueBit',
            'Mondwest', 'Collapse')
DISABLED_PROVIDER = '''// Agent-box flavor: no redistribution grant for the Photon implementation.
function disabled() {
  throw new Error("WhatsApp Business is disabled in this image: @photon-ai/whatsapp-business is not distributed (no license grant).");
}
export const whatsappBusiness = new Proxy(disabled, {
  get: disabled,
  apply: disabled,
  construct: disabled,
});
'''


def system_font_css(text):
    """Remove proprietary faces and change declarations in source + built CSS."""
    def face(match):
        block = match.group(0)
        return '' if any(name in block for name in FAMILIES) else block
    text = re.sub(r'@font-face\s*\{[^{}]*\}', face, text, flags=re.I)
    for family in FAMILIES:
        text = re.sub(r'''(["'])''' + re.escape(family) + r'\1',
                      'system-ui', text)
        # Minifiers commonly remove quotes from single-word family names.
        text = re.sub(r'(?<=:)\s*' + re.escape(family) + r'(?=\s*[,;}])',
                      'system-ui', text)
    return text


DONUT_TEMPLATE = 'opt/hermes/skills/creative/pretext/templates/donut-orbit.html'
DONUT_CDN = 'const DS_CDN = "https://esm.sh/@nous-research/ui@0.4.0/dist/fonts";'
DONUT_FACES = 'const FACES = [new FontFace("Mondwest", `url(${DS_CDN}/Mondwest-Regular.woff2) format("woff2")`, { weight: "400", display: "block" })];'


def system_font_html(text, *, donut=False):
    """Patch style blocks without applying CSS substitutions to JavaScript.

    The pinned donut template also loads Mondwest through FontFace. Keep the
    existing Promise.all/startup flow with an empty face list. Require its
    known declarations so upstream changes cannot silently restore downloads.
    """
    text = re.sub(r'(<style\b[^>]*>)(.*?)(</style\s*>)',
                  lambda m: m[1] + system_font_css(m[2]) + m[3], text,
                  flags=re.I | re.S)
    if donut:
        if text.count(DONUT_CDN) != 1 or text.count(DONUT_FACES) != 1:
            raise ValueError(f'unexpected dynamic font layout: {DONUT_TEMPLATE}')
        text = text.replace(DONUT_CDN, '').replace(DONUT_FACES, 'const FACES = [];')
        if 'DS_CDN' in text or 'Mondwest-Regular.woff2' in text:
            raise ValueError(f'residual proprietary font download: {DONUT_TEMPLATE}')
    return text


def read_payload_text(path):
    """Fail closed with the offending path when payload text is not UTF-8."""
    try:
        return path.read_text(encoding='utf-8')
    except UnicodeDecodeError as exc:
        raise ValueError(f'non-UTF-8 payload: {path}') from exc


def rewrite_source_map(source_map):
    """Rewrite embedded CSS; discard malformed optional embedded content."""
    if not isinstance(source_map, dict):
        return False
    changed = False
    contents = source_map.get('sourcesContent')
    if isinstance(contents, list):
        for index, content in enumerate(contents):
            if isinstance(content, str) and '@font-face' in content:
                rewritten = system_font_css(content)
                if rewritten != content:
                    contents[index] = rewritten
                    changed = True
    elif contents is not None:
        # sourcesContent is optional. Invalid scalar/object values are not
        # source arrays and may hide unrewritten font CSS; omit them entirely.
        del source_map['sourcesContent']
        changed = True
    sections = source_map.get('sections')
    if isinstance(sections, list):
        for section in sections:
            if isinstance(section, dict) and rewrite_source_map(section.get('map')):
                changed = True
    return changed


def files(root):
    for parent, dirs, names in os.walk(root, followlinks=False):
        dirs[:] = [d for d in dirs if not (Path(parent) / d).is_symlink()]
        if Path(parent) == root:
            dirs[:] = [d for d in dirs if d not in ('proc', 'sys', 'dev')]
        for name in names:
            path = Path(parent) / name
            if path.is_file() and not path.is_symlink():
                yield path


def remove(path):
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def sanitize(root, policy):
    hermes = root / 'opt/hermes'
    sidecar = hermes / 'plugins/platforms/photon/sidecar/node_modules'
    wrapper = sidecar / '@spectrum-ts/whatsapp-business'
    metadata = json.loads((wrapper / 'package.json').read_text())
    if metadata['version'] != '8.0.0':
        raise ValueError('unexpected Spectrum WhatsApp wrapper version')
    entry = wrapper / 'dist/index.js'
    if 'from "@photon-ai/whatsapp-business"' not in entry.read_text():
        raise ValueError('unexpected Spectrum WhatsApp import layout')
    entry.write_text(DISABLED_PROVIDER)
    # No retained sourcemap pointing at the replaced entry.
    remove(wrapper / 'dist/index.js.map')
    excluded = sidecar / '@photon-ai/whatsapp-business'
    if json.loads((excluded / 'package.json').read_text())['version'] != '0.1.1':
        raise ValueError('unexpected Photon WhatsApp version')
    remove(excluded)

    report = {'removed': [], 'patched_css': [], 'patched_html': [], 'policy': 'HEX-193'}
    # The pinned base keeps its only playwright-core inside an npx cache.
    # Preserve the self-contained MIT package at a readable runtime path before
    # clearing compressed install caches (also usable by uid 1000 smoke tests).
    playwright = list((root / 'root/.npm/_npx').glob('*/node_modules/playwright-core'))
    if len(playwright) != 1:
        raise ValueError('expected exactly one pinned npx playwright-core package')
    if json.loads((playwright[0] / 'package.json').read_text())['version'] != '1.62.1':
        raise ValueError('unexpected playwright-core version')
    target = root / 'opt/agent-box/playwright-core'
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(playwright[0], target)
    report['preserved_playwright'] = {
        'source': '/' + str(playwright[0].relative_to(root)),
        'destination': '/opt/agent-box/playwright-core', 'version': '1.62.1'}
    # Caches can retain compressed wheels/npm archives whose hashes differ
    # from their members. Remove build caches before scanning regular files.
    for base in ('root', 'home/hermes', 'home/agent', 'opt/hermes'):
        for cache in ('.cache', '.npm'):
            remove(root / base / cache)
    remove(hermes / '.playwright')
    for path in list(files(root)):
        rel = path.relative_to(root).as_posix()
        # Preserve the additive historical evidence and notices byte-for-byte.
        if rel.startswith('usr/share/doc/agent-box-hermes/'):
            continue
        if path.suffix == '.map' and rel.startswith('opt/hermes/'):
            # Source maps can retain the original CSS even after output patching.
            try:
                source_map = json.loads(read_payload_text(path))
            except json.JSONDecodeError:
                source_map = {}
            if rewrite_source_map(source_map):
                path.write_text(json.dumps(source_map, separators=(',', ':')),
                                encoding='utf-8')
        if path.suffix == '.html' and rel.startswith('opt/hermes/'):
            old = read_payload_text(path)
            new = system_font_html(old, donut=rel == DONUT_TEMPLATE)
            if new != old:
                path.write_text(new, encoding='utf-8')
                report['patched_html'].append('/' + rel)
        if path.suffix == '.css' and rel.startswith('opt/hermes/'):
            old = read_payload_text(path)
            new = system_font_css(old)
            if new != old:
                path.write_text(new, encoding='utf-8')
                report['patched_css'].append('/' + rel)
        with path.open('rb') as f:
            digest = hashlib.file_digest(f, 'sha256').hexdigest()
        if digest in policy['sha256'] or (
                'claude_agent_sdk/_bundled/' in rel and path.name in ('claude', 'claude.exe')):
            report['removed'].append({'path': '/' + rel, 'sha256': digest})
            path.unlink()
    removed_hashes = {x['sha256'] for x in report['removed']}
    font_hashes = {h for h, label in policy['sha256'].items() if label.startswith('font:')}
    if not font_hashes <= removed_hashes:
        raise ValueError('not all 14 expected proprietary font hashes were found')
    if not report['patched_css']:
        raise ValueError('no proprietary font CSS found')
    # Playwright uses this slot for video encoding; browser selection is
    # explicit via AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium.
    ffmpeg = hermes / '.playwright/ffmpeg-1011/ffmpeg-linux'
    ffmpeg.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg.symlink_to('/usr/bin/ffmpeg')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    report = sanitize(args.root.resolve(), json.loads(POLICY.read_text()))
    args.report.write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
