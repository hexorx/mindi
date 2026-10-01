"""Keep the inherited computer-use lazy pin aligned with the security overlay."""
from pathlib import Path

OLD = '"httpx2==2.7.0",  # mcp 2.x HTTP stack — keep in sync with pyproject [computer-use]'
NEW = OLD.replace('2.7.0', '2.12.0')


def patch(path):
    source = path.read_text()
    if source.count(OLD) != 1:
        raise ValueError('Hermes lazy dependency layout changed; review computer-use pin')
    path.write_text(source.replace(OLD, NEW))


if __name__ == '__main__':
    patch(Path('/opt/hermes/tools/lazy_deps.py'))
