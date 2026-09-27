"""Restore an offline memory archive into an empty, private volume."""
import os
from pathlib import Path
import sys
import tarfile


def restore(stream, root):
    if any(root.iterdir()):
        raise ValueError('memory: restore requires an empty destination')
    with tarfile.open(fileobj=stream, mode='r|gz') as archive:
        archive.extractall(root, filter='data')
    # The data filter deliberately discards directory modes. Its default 0755
    # fails PostgreSQL's 0700/0750 data-directory check. Keep every restored
    # directory private, including pg0's cluster and executable cache.
    for path in [root, *root.rglob('*')]:
        if not path.is_symlink() and path.is_dir():
            path.chmod(0o700)
        os.chown(path, 1000, 1000, follow_symlinks=False)


if __name__ == '__main__':
    try:
        restore(sys.stdin.buffer, Path('/restore'))
    except ValueError as error:
        raise SystemExit(str(error))
