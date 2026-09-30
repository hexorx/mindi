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

    report = {'removed': [], 'patched_css': [], 'policy': 'HEX-193'}
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
                source_map = json.loads(path.read_text())
            except (ValueError, UnicodeDecodeError):
                source_map = {}
            contents = source_map.get('sourcesContent', [])
            if any(isinstance(x, str) and '@font-face' in x for x in contents):
                source_map['sourcesContent'] = [
                    system_font_css(x) if isinstance(x, str) and '@font-face' in x else x
                    for x in contents]
                path.write_text(json.dumps(source_map, separators=(',', ':')))
        if path.suffix == '.css' and rel.startswith('opt/hermes/'):
            old = path.read_text()
            new = system_font_css(old)
            if new != old:
                path.write_text(new)
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
