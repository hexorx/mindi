"""The runtime exposure probe must work offline and reject non-private binds."""
import io
import json
from pathlib import Path
import runpy
import socket
import unittest
from unittest.mock import MagicMock, patch

PROBE = Path(__file__).with_name('memory-probe.py')


class MemoryProbeTest(unittest.TestCase):
    def run_probe(self, address='0200007F', table='/proc/net/tcp', forwarded=111):
        def read_text(path, *args, **kwargs):
            if path.name == 'config.json':
                return json.dumps({'mode': 'local_external', 'bank_id': 'test-bank'})
            if path.name == 'instance.json':
                return json.dumps({'port': 5432})
            if str(path) in ('/proc/net/tcp', '/proc/net/tcp6'):
                rows = 'header\n'
                if str(path) == table:
                    for port in (8888, 5432):
                        rows += f'0: {address}:{port:04X} 00000000:0000 0A\n'
                return rows
            raise AssertionError(f'Unexpected read: {path}')

        def urlopen(request, **kwargs):
            body = ({'fact': 'cobalt-orchid-742'}
                    if '/test-bank/' in request.full_url else {})
            return io.BytesIO(json.dumps(body).encode())

        connection = MagicMock()
        connection.__enter__.return_value.connect_ex.return_value = forwarded
        with patch.object(Path, 'read_text', read_text), \
                patch.object(Path, 'is_file', return_value=True), \
                patch('urllib.request.urlopen', side_effect=urlopen), \
                patch('socket.create_connection') as connect, \
                patch('socket.socket', return_value=connection), \
                patch('socket.gethostbyname', side_effect=socket.gaierror('offline')) as dns, \
                patch('sys.argv', [str(PROBE), 'retain']), \
                patch('sys.stdout', new_callable=io.StringIO):
            runpy.run_path(str(PROBE), run_name='__main__')
            dns.assert_not_called()
            self.assertEqual([call.args[0] for call in connect.call_args_list],
                             [('127.0.0.2', 8888), ('127.0.0.2', 5432)])

    def test_network_none_needs_no_hostname_resolution(self):
        self.run_probe()

    def test_rejects_non_private_ipv4_and_ipv6_listeners(self):
        for address, table in [('00000000', '/proc/net/tcp'),
                               ('0100007F', '/proc/net/tcp'),
                               ('020011AC', '/proc/net/tcp'),
                               ('0' * 32, '/proc/net/tcp6'),
                               ('00000000000000000000000001000000', '/proc/net/tcp6')]:
            with self.subTest(address=address), self.assertRaisesRegex(AssertionError, 'private loopback'):
                self.run_probe(address, table)

    def test_rejects_forwarded_loopback_reachability(self):
        with self.assertRaises(AssertionError):
            self.run_probe(forwarded=0)
