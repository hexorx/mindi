"""Seed subscription inference settings without API keys."""
import json
import os
from pathlib import Path
import re
import tempfile


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


def seed(home, env):
    """Seed subscription auth only; login tokens belong to the persistent home."""
    provider = env.get('HERMES_INFERENCE_PROVIDER') or 'openai-codex'
    model = env.get('HERMES_INFERENCE_MODEL') or 'gpt-5.6-sol'
    if (provider != 'openai-codex' or env.get('HERMES_INFERENCE_BASE_URL')
            or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', model)):
        raise ValueError('Use openai-codex subscription auth (values redacted)')
    root = Path(home)
    if root.is_symlink() or root.parent.is_symlink():
        raise ValueError('Invalid inference home')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    os.chown(root, 1000, 1000)
    config = root / 'config.yaml'
    if config.is_symlink():
        if os.readlink(config) != '.agent-box/current/config.yaml':
            raise ValueError('Invalid inference config link')
        return
    if not config.exists():
        publish_missing(config, json.dumps({'model': {
            'provider': provider, 'default': model,
            'base_url': 'https://chatgpt.com/backend-api/codex',
        }}) + '\n')


if __name__ == "__main__":
    seed(os.environ.get("HERMES_HOME", "/home/agent/.hermes"), os.environ)
