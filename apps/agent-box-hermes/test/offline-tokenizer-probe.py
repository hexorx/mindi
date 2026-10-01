"""Run with the installed Hindsight interpreter, cache env and no network."""
import hashlib
import importlib.util
from importlib.metadata import distribution, version
import json
import os
from pathlib import Path
import sys

attempts = []


def deny_network(event, args):
    if event in ('socket.connect', 'socket.getaddrinfo', 'socket.sendto'):
        attempts.append(event)
        raise RuntimeError('network attempted during offline tokenizer probe')


sys.addaudithook(deny_network)
cache = Path(os.environ['TIKTOKEN_CACHE_DIR'])
manifest_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/usr/share/doc/agent-box-hermes/third-party/hex240-tokenizer-inputs/manifest.json')
manifest = json.loads(manifest_path.read_text())
before = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in cache.iterdir()}
for entry in manifest['encodings']:
    assert before[entry['cache_key']] == entry['sha256']

# Imports happen after the audit hook: even a caught remote-map fallback fails.
import tiktoken
import litellm
from litellm.litellm_core_utils.get_model_cost_map import GetModelCostMap, get_model_cost_map_source_info
# Load the installed counting module directly; the separate boot test covers
# Hindsight's full server imports and startup (including its provider graph).
for name, expected in manifest['versions'].items():
    assert version(name) == expected, name
source = distribution('hindsight-api-slim').locate_file('hindsight_api/engine/token_encoding.py')
spec = importlib.util.spec_from_file_location('hindsight_token_encoding', source)
hindsight_tokens = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hindsight_tokens)

assert os.environ['LITELLM_LOCAL_MODEL_COST_MAP'] == 'True'
packaged = GetModelCostMap.load_local_model_cost_map_with_revision()
source_info = get_model_cost_map_source_info()
assert source_info['source'] == 'local'
assert source_info['is_env_forced'] is True
assert source_info['url'] is None and source_info['fallback_reason'] is None
assert source_info['source_revision'] == packaged.revision
assert litellm.model_cost['gpt-4o-mini'] == packaged.model_cost_map['gpt-4o-mini']
text = 'Offline startup: hello <|endoftext|> world.'
for name in ('cl100k_base', 'o200k_base'):
    encoding = tiktoken.get_encoding(name)
    assert encoding.decode(encoding.encode(text, disallowed_special=())) == text
encoding = hindsight_tokens.get_token_encoding()
assert encoding.decode(encoding.encode(text)) == text
assert not attempts, attempts
assert before == {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in cache.iterdir()}
print('Offline tokenizer and packaged LiteLLM map passed; zero network attempts.')
