"""Offline compatibility checks for the narrow Hermes overlay."""
import asyncio
import importlib.metadata as metadata
import sys
from unittest.mock import patch

from packaging.requirements import Requirement
import httpx2
import httpcore2
import jwt
import msal
import tornado.escape
from cryptography.hazmat.primitives.asymmetric import rsa

EXPECTED = {'httpx2': '2.12.0', 'httpcore2': '2.12.0', 'tornado': '6.5.8'}
for name, version in EXPECTED.items():
    assert metadata.version(name) == version, name
    for text in metadata.requires(name) or []:
        req = Requirement(text)
        if req.marker is None or req.marker.evaluate({'extra': ''}):
            assert metadata.version(req.name) in req.specifier, text

# Preserve, and exercise, the inherited explicit cryptography override. MSAL
# 1.36.0 declares <49; this pre-existing metadata mismatch is not silently fixed.
assert metadata.version('msal') == '1.36.0'
assert metadata.version('cryptography') == '50.0.0'
key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
token = jwt.encode({'sub': 'overlay-smoke'}, key, algorithm='RS256')
assert jwt.decode(token, key.public_key(), algorithms=['RS256'])['sub'] == 'overlay-smoke'
assert msal.SerializableTokenCache().serialize()
assert tornado.escape.xhtml_escape('<test>') == '&lt;test&gt;'
with httpx2.Client(transport=httpx2.MockTransport(lambda request: httpx2.Response(200))) as client:
    assert client.get('https://offline.invalid').status_code == 200

async def check_async():
    async with httpx2.AsyncClient(transport=httpx2.MockTransport(lambda request: httpx2.Response(200))) as client:
        assert (await client.get('https://offline.invalid')).status_code == 200

asyncio.run(check_async())
print('Python overlay: dependency bounds and offline HTTP/JWT/MSAL/Tornado checks passed')

# Exercise the same readiness gate used by CuaBackend before starting the driver.
# A stale lazy pin must fail the image build, without attempting an install.
sys.path.insert(0, '/opt/hermes')
from tools import lazy_deps
missing = lazy_deps.feature_missing('tool.computer_use')
assert not missing, f'Computer-use dependencies missing: {missing}'
with patch.object(lazy_deps, '_venv_pip_install', side_effect=AssertionError('unexpected lazy install')):
    lazy_deps.ensure('tool.computer_use', prompt=False)
print('Computer-use dependency readiness passed without runtime installation')
