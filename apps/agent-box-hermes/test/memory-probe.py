"""Exercise real Hindsight/pg0 over HTTP; provider responses alone are mocked."""
import json
from pathlib import Path
import socket
import sys
import urllib.request

config = json.loads(Path('/home/agent/.hermes/hindsight/config.json').read_text())
assert config['mode'] == 'local_external'
bank = config['bank_id']
base = 'http://127.0.0.2:8888/v1/default/banks/'
fact = 'The persistent memory verification code is cobalt-orchid-742.'


def post(bank_id, path, body):
    req = urllib.request.Request(base + bank_id + path, json.dumps(body).encode(),
                                 {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=90) as response:
        return json.load(response)


if sys.argv[1] == 'retain':
    post(bank, '/memories', {'items': [{'content': fact}], 'async': False})
result = post(bank, '/memories/recall', {'query': 'persistent memory verification code', 'types': ['world']})
assert 'cobalt-orchid-742' in json.dumps(result), 'Stored fact missing from recall'
# Another bank in the same database must not see the first bank's fact.
other = post('box-isolation-fixture', '/memories/recall', {'query': 'persistent memory verification code'})
assert 'cobalt-orchid-742' not in json.dumps(other)
data = Path('/var/lib/agent-box/hindsight/.pg0/instances/hindsight/data')
assert (data / 'PG_VERSION').is_file(), 'pg0 did not persist inside the memory volume'
# Both services must be reachable locally but absent from Tailscale's forwarded
# loopback address and every non-loopback interface, including IPv6 listeners.
state = json.loads((data.parent / 'instance.json').read_text())
for port in (8888, state['port']):
    with socket.create_connection(('127.0.0.2', port), timeout=1):
        pass
    for table in ('/proc/net/tcp', '/proc/net/tcp6'):
        for line in Path(table).read_text().splitlines()[1:]:
            parts = line.split()
            address, encoded_port = parts[1].split(':')
            if parts[3] == '0A' and int(encoded_port, 16) == port:
                assert address == '0200007F', 'Memory listener is not on private loopback'
    for host in ('127.0.0.1', socket.gethostbyname(socket.gethostname())):
        with socket.socket() as connection:
            connection.settimeout(1)
            assert connection.connect_ex((host, port)) != 0
print('Real retain/recall, private listeners, volume path and bank isolation passed')
