#!/usr/bin/env python3
"""Check the built filesystem AND each saved layer for removed vendor files."""
import json
import subprocess
import sys
import tarfile

image, archive = sys.argv[1:]
result = subprocess.run(['docker', 'run', '--rm', '--network=none', '--entrypoint', 'sh', image, '-ec',
    "dpkg-query -W -f='${Package} ${db:Status-Status}\\n' | awk '$1 ~ /^google-chrome/ && $2 == \"installed\" {print; bad=1} END {exit bad}'; "
    "test -z \"$(find / -path '*claude-code*' -o -name 'google-chrome*' 2>/dev/null)\""], check=True)
with tarfile.open(archive) as outer:
    manifest = json.load(outer.extractfile('manifest.json'))
    for layer in manifest[0]['Layers']:
        with tarfile.open(fileobj=outer.extractfile(layer), mode='r|*') as inner:
            for member in inner:
                if 'claude-code' in member.name or member.name.rsplit('/', 1)[-1].startswith('google-chrome'):
                    raise SystemExit(f'Bundled vendor file in {layer}: {member.name}')
print('PASS: no Claude Code or google-chrome packages/files in filesystem or any image layer')
