#!/usr/bin/env python3
"""Check the built filesystem AND each saved layer for removed vendor files."""
import json
import subprocess
import sys
import tarfile


def is_vendor_payload_path(path):
    """Match installed vendor payloads without rejecting unrelated documentation."""
    normalized = '/' + path.lstrip('./').lstrip('/')
    filename = normalized.rsplit('/', 1)[-1]
    return (
        '/node_modules/@anthropic-ai/claude-code' in normalized
        or '/claude_agent_sdk/_bundled' in normalized
        or normalized == '/opt/google/chrome'
        or normalized.startswith('/opt/google/chrome/')
        or filename.startswith('google-chrome')
    )


FILESYSTEM_CHECK = r'''packages="$(dpkg-query -W -f='${Package} ${db:Status-Status}\n' |
    awk '$1 ~ /^google-chrome/ && $2 == "installed" {print}')"
paths="$(find / -xdev \( -path '*/node_modules/@anthropic-ai/claude-code*' \
    -o -path '*/claude_agent_sdk/_bundled*' \
    -o -path '/opt/google/chrome' -o -path '/opt/google/chrome/*' \
    -o -name 'google-chrome*' \) -print 2>/dev/null)"
bad=0
if [ -n "$packages" ]; then
    printf 'Bundled vendor packages:\n%s\n' "$packages"
    bad=1
fi
if [ -n "$paths" ]; then
    printf 'Bundled vendor filesystem paths:\n%s\n' "$paths"
    bad=1
fi
exit "$bad"'''


def check_filesystem(image):
    result = subprocess.run(
        ['docker', 'run', '--rm', '--network=none', '--entrypoint', 'sh',
         image, '-ec', FILESYSTEM_CHECK],
        text=True, capture_output=True,
    )
    if result.stdout:
        print(result.stdout, end='')
    if result.stderr:
        print(result.stderr, end='', file=sys.stderr)
    if result.returncode:
        raise SystemExit(
            f'Built filesystem contains bundled vendor payload (exit {result.returncode})'
        )


def check_layers(archive):
    violations = []
    with tarfile.open(archive) as outer:
        manifest_file = outer.extractfile('manifest.json')
        if manifest_file is None:
            raise SystemExit('Image archive has no manifest.json')
        manifest = json.load(manifest_file)
        for layer in manifest[0]['Layers']:
            layer_file = outer.extractfile(layer)
            if layer_file is None:
                raise SystemExit(f'Image archive is missing layer: {layer}')
            with tarfile.open(fileobj=layer_file, mode='r|*') as inner:
                for member in inner:
                    name = member.name
                    if is_vendor_payload_path(name):
                        violations.append(f'Bundled vendor file in {layer}: {name}')
    if violations:
        raise SystemExit('\n'.join(violations))


def main(argv):
    if len(argv) != 2:
        raise SystemExit('usage: check_unbundled.py IMAGE IMAGE_TAR')
    image, archive = argv
    check_filesystem(image)
    check_layers(archive)
    print('PASS: no Claude Code or google-chrome packages/files in filesystem or any image layer')


if __name__ == '__main__':
    main(sys.argv[1:])
