"""Seed subscription inference settings without API keys."""
import errno
import json
import os
import pwd
from pathlib import Path
import re
import stat
import tempfile


def publish_missing(path, value, uid, gid):
    """Publish a complete private file without replacing operator-owned state."""
    fd, temporary = tempfile.mkstemp(prefix='.inference-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchown(stream.fileno(), uid, gid)
        try:
            os.link(temporary, path)
        except FileExistsError:
            pass
    finally:
        Path(temporary).unlink(missing_ok=True)


def repair_private_files(root, uid, gid):
    """Repair only regular private files; never traverse a symlink component."""
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in root.absolute().parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=directory)
            os.close(directory)
            directory = child
        os.fchown(directory, uid, gid)
        for name in ('config.yaml', 'auth.json'):
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                             dir_fd=directory)
            except FileNotFoundError:
                continue
            except OSError as error:
                # The supported generated config link belongs to the config
                # publisher. Do not follow it or change its target's ownership.
                if error.errno == errno.ELOOP and name == 'config.yaml' and os.readlink(name, dir_fd=directory) == '.agent-box/current/config.yaml':
                    continue
                raise
            try:
                current = os.fstat(fd)
                if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
                    raise ValueError('Invalid private inference file')
                if (current.st_uid, current.st_gid) != (uid, gid):
                    os.fchown(fd, uid, gid)
                    # chown can clear special mode bits; retain the exact mode.
                    os.fchmod(fd, stat.S_IMODE(current.st_mode))
            finally:
                os.close(fd)
    finally:
        os.close(directory)


def seed(home, env):
    """Seed subscription auth only; login tokens belong to the persistent home."""
    provider = env.get('HERMES_INFERENCE_PROVIDER') or 'openai-codex'
    model = env.get('HERMES_INFERENCE_MODEL') or 'gpt-5.6-sol'
    if (provider != 'openai-codex' or env.get('HERMES_INFERENCE_BASE_URL')
            or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', model)):
        raise ValueError('Use openai-codex subscription auth (values redacted)')
    root = Path(home)
    if any(path.is_symlink() for path in (root, *root.parents)):
        raise ValueError('Invalid inference home')
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    owner = pwd.getpwnam("hermes")
    repair_private_files(root, owner.pw_uid, owner.pw_gid)
    config = root / 'config.yaml'
    if config.is_symlink():
        if os.readlink(config) != '.agent-box/current/config.yaml':
            raise ValueError('Invalid inference config link')
        return
    if not config.exists():
        publish_missing(config, json.dumps({'model': {
            'provider': provider, 'default': model,
            'base_url': 'https://chatgpt.com/backend-api/codex',
        }}) + '\n', owner.pw_uid, owner.pw_gid)


if __name__ == "__main__":
    seed(os.environ.get("HERMES_HOME", "/home/agent/.hermes"), os.environ)
