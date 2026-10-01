"""Download only reviewed tokenizer assets and reject wheel/input drift."""
import hashlib
from importlib.metadata import version
import json
import os
import sys
from pathlib import Path
import urllib.request
from unittest.mock import patch

MANIFEST = Path('/usr/share/doc/agent-box-hermes/third-party/hex240-tokenizer-inputs/manifest.json')


def install(manifest, cache, fetch):
    cache.mkdir(parents=True, exist_ok=True)
    cache.chmod(0o755)
    for entry in manifest['encodings']:
        key = hashlib.sha1(entry['url'].encode()).hexdigest()
        if key != entry['cache_key']:
            raise ValueError('tokenizer URL/cache key mismatch')
        data = fetch(entry['url'])
        if hashlib.sha256(data).hexdigest() != entry['sha256']:
            raise ValueError('tokenizer checksum mismatch: ' + entry['encoding'])
        target = cache / key
        target.write_bytes(data)
        target.chmod(0o644)


def verify_constructors(manifest):
    from tiktoken_ext import openai_public
    for entry in manifest['encodings']:
        with patch.object(openai_public, 'load_tiktoken_bpe', return_value={}) as load:
            getattr(openai_public, entry['encoding'])()
            load.assert_called_once_with(entry['url'], expected_hash=entry['sha256'])


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as response:
        return response.read()


if __name__ == '__main__':
    manifest = json.loads((Path(sys.argv[1]) if len(sys.argv) > 1 else MANIFEST).read_text())
    for name, expected in manifest['versions'].items():
        if version(name) != expected:
            raise ValueError('review tokenizer behavior for changed dependency: ' + name)
    verify_constructors(manifest)
    install(manifest, Path(os.environ['TIKTOKEN_CACHE_DIR']), fetch)
