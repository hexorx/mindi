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
    return json.loads(run(['docker', 'exec', '-e', 'SMOKE_REQUEST=' + payload,
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


def main():
    image = sys.argv[1]
    subscription = '--subscription' in sys.argv[2:]
    auth = subscription_document(os.environ.get('HERMES_SUBSCRIPTION_AUTH_JSON', '')) if subscription else None
    scratch = Path(os.environ['RUNNER_TEMP']) / ('original-box-' + secrets.token_hex(6))
    scratch.mkdir(mode=0o755)
    for filename in ('backend.json', 'SOUL.md'):
        (scratch / filename).write_bytes((APP / 'example' / filename).read_bytes())
    (scratch / 'token').write_text(secrets.token_hex(32))
    for path in scratch.iterdir():
        path.chmod(0o644)  # Synthetic fixture inputs must be readable by the hermes user.
    name = scratch.name
    args = ['docker', 'create', '--name', name, '--shm-size=256m',
            '-e', 'MINDI_BACKEND_CONFIG=/run/backend-example/backend.json',
            '-e', 'MINDI_BACKEND_TOKEN_FILE=/run/backend-example/token',
            '-e', 'HINDSIGHT_ENABLED=0',
            '-e', 'AGENT_BOX_RUN_DIR=/tmp/agent-box']
    if not subscription:
        args += ['--network=none']
    run([*args, image])
    try:
        run(['docker', 'cp', str(scratch), name + ':/run/backend-example'])
        run(['docker', 'start', name])
        wait_desktop(name)
        # Login stores must be writable by the same account that runs agents.
        run(['docker', 'exec', '--user', 'hermes', name, 'sh', '-ec',
             'test -w /home/agent/.hermes/config.yaml; '
             'test -w /home/agent/.omp; '
             'test -f /tmp/agent-box/waiting-hindsight'])
        # Both binaries must be available; never invoke a paid provider.
        run(['docker', 'exec', '--user', 'hermes', name, 'claude', '--version'])
        run(['docker', 'exec', '--user', 'hermes', name, 'hermes', '--help'])
        if auth is not None:
            writer = "import os,sys; p='/home/agent/.hermes/auth.json'; fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); data=sys.stdin.buffer.read(); f=os.fdopen(fd,'wb'); f.write(data); f.close()"
            run(['docker', 'exec', '-i', '--user', 'hermes', name,
                 'python3', '-c', writer], input=auth)
        # Same home survives normal restart, including the subscription login.
        run(['docker', 'restart', '--time', '20', name])
        wait_desktop(name)
        if auth is not None:
            challenge = 'HERMES_OK_' + secrets.token_hex(12)
            answer = run(['docker', 'exec', '--user', 'hermes', name,
                          'hermes', 'chat', '--provider', 'openai-codex', '--quiet',
                          '--query', 'Reply with exactly ' + challenge + ' and nothing else.'],
                         timeout=180).stdout.decode().strip()
            if answer != challenge:
                raise ValueError('Subscription answer did not match')
        print('Backend and two persona desktops ready across restart; ' +
              ('Hermes subscription answer passed.' if subscription else 'offline startup passed.'))
    finally:
        # Preserve containers/volumes and credentials; no cleanup deletes or log uploads.
        run(['docker', 'stop', '--time', '20', name])


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Original-box smoke failed (details redacted; no API-key fallback)') from None
