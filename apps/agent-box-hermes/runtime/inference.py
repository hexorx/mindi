"""Seed optional z.ai inference settings before config-source activation."""
import json
import os
from pathlib import Path
import re
import tempfile
from urllib.parse import urlsplit


def publish_missing(path, value):
    """Publish a complete private file without replacing operator-owned state."""
    fd, temporary = tempfile.mkstemp(prefix='.inference-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchown(stream.fileno(), 1000, 1000)
        try:
            os.link(temporary, path)
        except FileExistsError:
            pass
    finally:
        Path(temporary).unlink(missing_ok=True)


def seed(home, env, secret=Path('/run/secrets/inference_api_key')):
    provider, model, base_url = (env.get('HERMES_INFERENCE_' + key, '')
                                 for key in ('PROVIDER', 'MODEL', 'BASE_URL'))
    if not any((provider, model, base_url)):
        return
    # This bootstrap currently supports the z.ai GLM credential contract only.
    url = urlsplit(base_url)
    if (provider != 'zai' or not re.fullmatch(r'[A-Za-z0-9_./:-]{1,256}', model)
            or url.scheme != 'https' or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.port not in (None, 443)
            or any(c.isspace() or c in "'\\\"$" for c in base_url)):
        raise ValueError('Invalid inference settings (values redacted)')
    root = Path(home)
    if root.is_symlink() or root.parent.is_symlink():
        raise ValueError('Invalid inference home')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    os.chown(root, 1000, 1000)
    target = root / '.env'
    if target.is_symlink():
        raise ValueError('Invalid inference env file')
    if not target.exists():
        with Path(secret).open('rb') as stream:
            key = stream.read(8193).rstrip(b'\r\n')
        # Restrict to printable token characters; no dotenv quoting/interpolation.
        if not 1 <= len(key) <= 8192 or any(c < 33 or c > 126 or chr(c) in "'\"\\$#`" for c in key):
            raise ValueError('Invalid inference key (values redacted)')
        publish_missing(target, f"GLM_API_KEY={key.decode('ascii')}\nGLM_BASE_URL={base_url}\n")
    config = root / 'config.yaml'
    # Managed symlinks belong to config_sources; never replace or follow them here.
    if not config.exists() and not config.is_symlink():
        publish_missing(config, json.dumps({'model': {'provider': provider, 'default': model,
                                                     'base_url': base_url}}) + '\n')
