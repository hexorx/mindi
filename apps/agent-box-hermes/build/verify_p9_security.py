"""Offline regressions for the P9 urllib3 and Tornado security overlay."""
import io
from pathlib import Path
import tempfile
from unittest.mock import Mock

import urllib3
from urllib3.exceptions import ProtocolError
from tornado.web import HTTPError, StaticFileHandler


def verify():
    # Normal chunk sizes still parse; overlong lines are bounded and rejected.
    response = urllib3.response.HTTPResponse(preload_content=False)
    response._fp = Mock(fp=io.BytesIO(b'3\r\n'))
    response._update_chunk_length()
    assert response.chunk_left == 3
    response.chunk_left = None
    stream = io.BytesIO(b'1' * 70000 + b'\r\n')
    response._fp = Mock(fp=stream)
    try:
        response._update_chunk_length()
    except ProtocolError:
        assert stream.tell() <= 65537
    else:
        raise AssertionError('Unbounded chunk-size line accepted')

    # A file under the root remains usable; a symlink outside it must fail.
    with tempfile.TemporaryDirectory() as scratch:
        root = Path(scratch) / 'static'
        root.mkdir()
        (root / 'safe').write_text('safe')
        outside = Path(scratch) / 'outside'
        outside.write_text('outside')
        (root / 'escape').symlink_to(outside)
        handler = object.__new__(StaticFileHandler)
        handler.initialize(str(root))
        handler.path = 'safe'
        assert handler.validate_absolute_path(str(root), str(root / 'safe')) == str(root / 'safe')
        handler.path = 'escape'
        try:
            handler.validate_absolute_path(str(root), str(root / 'escape'))
        except HTTPError as error:
            assert error.status_code == 403
        else:
            raise AssertionError('Static symlink escaped its root')
    print('P9 offline chunk-size and static symlink regressions passed')


if __name__ == '__main__':
    verify()
