#!/usr/bin/env python3
"""Real one-turn subscription smoke; capture output without exposing tokens."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs)


def main():
    image = sys.argv[1]
    # The operator supplies an existing Hermes OAuth auth.json at runtime only.
    auth = os.environ.get('HERMES_SUBSCRIPTION_AUTH_JSON', '')
    document = json.loads(auth)
    if not (document.get('providers', {}).get('openai-codex') or
            document.get('credential_pool', {}).get('openai-codex')):
        raise ValueError('Codex subscription credentials missing')
    scratch = Path(os.environ['RUNNER_TEMP']) / ('hermes-subscription-' + secrets.token_hex(6))
    scratch.mkdir(mode=0o700)
    name = scratch.name
    run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
         '-subj', '/CN=localhost', '-keyout', str(scratch / 'desktop_tls_key'),
         '-out', str(scratch / 'desktop_tls_cert')])
    (scratch / 'desktop_password').write_text(secrets.token_hex(24))
    for path in scratch.iterdir():
        path.chmod(0o600)
    try:
        run(['docker', 'run', '-d', '--name', name, '--shm-size=256m',
             '--security-opt=no-new-privileges',
             '-e', 'API_SERVER_KEY=release-local-api-fixture-key',
             '-e', 'PAPERCLIP_CALLBACK_KEY=release-local-callback-fixture-key',
             '-e', 'PAPERCLIP_API_URL=http://paperclip.invalid/api',
             '--mount', f'type=bind,src={scratch},dst=/run/secrets,readonly', image])
        for _ in range(150):
            state = json.loads(run(['docker', 'inspect', name]).stdout)[0]['State']
            if state['Status'] in ('exited', 'dead'):
                raise ValueError('Container failed to start')
            if state.get('Health', {}).get('Status') == 'healthy':
                break
            time.sleep(2)
        else:
            raise ValueError('Desktop/API health timed out')
        # stdin is never an image layer, Docker build argument or process argv.
        writer = "import os,sys; p='/home/agent/.hermes/auth.json'; fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600); os.write(fd,sys.stdin.buffer.read()); os.close(fd)"
        run(['docker', 'exec', '-i', '--user', '1000:1000', name, 'python3', '-c', writer], input=auth.encode())
        challenge = 'HERMES_OK_' + secrets.token_hex(12)
        answer = run(['docker', 'exec', '--user', '1000:1000', name,
                      '/opt/hermes/.venv/bin/hermes', 'chat', '--provider', 'openai-codex',
                      '--quiet', '--query', 'Reply with exactly ' + challenge + ' and nothing else.'],
                     timeout=180).stdout.decode().strip()
        if answer != challenge:
            raise ValueError('Subscription answer did not match the challenge')
        print('Container starts, desktop/API healthy, Codex subscription answer passed.')
    finally:
        # Keep evidence/data; Opi owns cleanup. Never upload container/auth logs.
        run(['docker', 'stop', '--time', '20', name])


if __name__ == '__main__':
    try:
        main()
    except Exception:
        raise SystemExit('Subscription smoke failed (details redacted; no API-key fallback)') from None
