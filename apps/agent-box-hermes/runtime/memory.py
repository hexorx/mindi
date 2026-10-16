"""Persistent built-in memory and box identity; no provider keys or database."""
import json
import os
from pathlib import Path
import sys
import uuid


def private_dir(path):
    if path.is_symlink():
        raise ValueError('memory: directory must not be a symlink')
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)


def write_private(path, value):
    if path.is_symlink():
        raise ValueError('memory: file must not be a symlink')
    temporary = path.with_name(path.name + '.tmp')
    fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, 'w') as out:
            out.write(value)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def configure_builtin(home):
    """Keep the stable box identity; leave every Hindsight database untouched."""
    root = Path(home)
    identity_dir = root.parent / '.agent-box'
    private_dir(identity_dir)
    identity = identity_dir / 'identity.json'
    if identity.is_symlink():
        raise ValueError('memory: identity must not be a symlink')
    if not identity.exists():
        write_private(identity, json.dumps({'schemaVersion': 1, 'boxId': str(uuid.uuid4()), 'name': 'helper'}))
    uuid.UUID(json.loads(identity.read_text())['boxId'])
    private_dir(root / 'memories')


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'configure':
            configure_builtin(os.environ['HERMES_HOME'])
        elif sys.argv[1] == 'run':
            # Preserve the s6 service name without starting or migrating pg0.
            os.execv('/command/s6-pause', ['s6-pause'])
        else:
            raise ValueError('memory: unknown lifecycle command')
    except (OSError, ValueError, KeyError, TypeError):
        raise SystemExit('memory: invalid file-memory state (values redacted)')
