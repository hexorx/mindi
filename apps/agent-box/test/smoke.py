#!/usr/bin/env python3
"""Original backend/desktop smoke; credentials only enter a fresh runtime home."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time

APP = Path(__file__).resolve().parents[1]


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs)


def request(name, path, method='GET', body=None):
    # This synthetic operator token is private to the disposable, unpublished container.
    program = '''import json,os,urllib.request
payload=json.loads(os.environ['SMOKE_REQUEST'])
body=payload['body']
token=open('/run/backend-example/token').read().strip()
request=urllib.request.Request('http://127.0.0.1:65005'+payload['path'],
 data=None if body is None else json.dumps(body).encode(),method=payload['method'],
 headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
print(urllib.request.urlopen(request,timeout=10).read().decode())
'''
    payload = json.dumps({'path': path, 'method': method, 'body': body})
    return json.loads(run(['docker', 'exec', '--user', '1000:1000', '-e', 'SMOKE_REQUEST=' + payload,
                          name, 'python3', '-c', program]).stdout)


def wait_desktop(name):
    for _ in range(120):
        state = json.loads(run(['docker', 'inspect', name]).stdout)[0]['State']
        if not state['Running']:
            raise ValueError('Container stopped before readiness')
        try:
            request(name, '/profiles')
            ready = True
            for persona in ('mindi', 'codi'):
                view = request(name, f'/profiles/{persona}/desktop')
                if not view['settings']['enabled']:
                    request(name, f'/profiles/{persona}/desktop', 'PATCH', {
                        'expectedRevision': view['settings']['revision'], 'enabled': True})
                ready &= view['desktop']['state'] == 'ready'
            if ready:
                return
        except subprocess.CalledProcessError:
            pass
        time.sleep(2)
    raise ValueError('Backend or persona desktops did not become ready')


def subscription_document(raw):
    document = json.loads(raw)
    if not (document.get('providers', {}).get('openai-codex') or
            document.get('credential_pool', {}).get('openai-codex')):
        raise ValueError('Codex subscription login missing')
    return raw.encode()


def prepare_fixture(scratch):
    for filename in ('backend.json', 'SOUL.md'):
        (scratch / filename).write_bytes((APP / 'example' / filename).read_bytes())
        (scratch / filename).chmod(0o644)
    token = scratch / 'token'
    token.write_text(secrets.token_hex(32))
    token.chmod(0o400)
    if (token.stat().st_uid, token.stat().st_gid) != (1000, 1000):
        run(['sudo', '-n', 'chown', '1000:1000', str(token)])
    stat = token.stat()
    if (stat.st_uid, stat.st_gid, stat.st_mode & 0o777) != (1000, 1000, 0o400):
        raise ValueError('Token fixture must be 1000:1000 mode 0400')


def verify_backend_identity(name):
    program = """from pathlib import Path
matches = []
for proc in Path('/proc').glob('[0-9]*'):
    try:
        if b'/opt/mindi-backend/dist/main.js' not in (proc/'cmdline').read_bytes().split(b'\\0'):
            continue
        status = dict(line.split(':', 1) for line in (proc/'status').read_text().splitlines() if ':' in line)
        assert status['Uid'].split() == ['1000'] * 4
        assert status['Gid'].split() == ['1000'] * 4
        matches.append(proc.name)
    except FileNotFoundError:
        continue
assert len(matches) == 1
"""
    run(['docker', 'exec', name, 'python3', '-c', program])
    mounts = json.loads(run(['docker', 'inspect', name]).stdout)[0]['Mounts']
    assert any(m['Destination'] == '/run/backend-example' and not m['RW'] for m in mounts)


def main():
    image = sys.argv[1]
    subscription = '--subscription' in sys.argv[2:]
    auth = subscription_document(os.environ.get('HERMES_SUBSCRIPTION_AUTH_JSON', '')) if subscription else None
    scratch = Path(os.environ['RUNNER_TEMP']) / ('original-box-' + secrets.token_hex(6))
    scratch.mkdir(mode=0o755)
    prepare_fixture(scratch)
    name = scratch.name
    args = ['docker', 'create', '--name', name, '--shm-size=256m',
            '--mount', f'type=bind,src={scratch},dst=/run/backend-example,readonly',
            '-e', 'MINDI_BACKEND_CONFIG=/run/backend-example/backend.json',
            '-e', 'MINDI_BACKEND_TOKEN_FILE=/run/backend-example/token',
            '-e', 'HINDSIGHT_ENABLED=0']
    if not subscription:
        args += ['--network=none']
    run([*args, image])
    try:
        run(['docker', 'start', name])
        wait_desktop(name)
        verify_backend_identity(name)
        # Both binaries must be available; never invoke a paid provider.
        run(['docker', 'exec', '--user', '1000:1000', name, 'claude', '--version'])
        run(['docker', 'exec', '--user', '1000:1000', name, 'hermes', '--help'])
        if auth is not None:
            writer = "import os,sys; p='/home/agent/.hermes/auth.json'; fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); data=sys.stdin.buffer.read(); f=os.fdopen(fd,'wb'); f.write(data); f.close()"
            run(['docker', 'exec', '-i', '--user', '1000:1000', name,
                 'python3', '-c', writer], input=auth)
        # Same home survives normal restart, including the subscription login.
        run(['docker', 'restart', '--time', '20', name])
        wait_desktop(name)
        verify_backend_identity(name)
        if auth is not None:
            challenge = 'HERMES_OK_' + secrets.token_hex(12)
            answer = run(['docker', 'exec', '--user', '1000:1000', name,
                          'hermes', 'chat', '--provider', 'openai-codex', '--quiet',
                          '--query', 'Reply with exactly ' + challenge + ' and nothing else.'],
                         timeout=180).stdout.decode().strip()
            if answer != challenge:
                raise ValueError('Subscription answer did not match')
        print('Backend UID/GID 1000:1000; read-only 0400 token; two persona desktops ready across restart; ' +
              ('Hermes subscription answer passed.' if subscription else 'offline startup passed.'))
    finally:
        # Preserve containers/volumes and credentials; no cleanup deletes or log uploads.
        run(['docker', 'stop', '--time', '20', name])


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Original-box smoke failed (details redacted; no API-key fallback)') from None
