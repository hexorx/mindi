"""Run the shipped nginx routing configuration against a fake native backend."""
import asyncio
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest
from aiohttp import ClientSession
from aiohttp.test_utils import TestServer
sys.path.insert(0, str(Path(__file__).parents[1] / 'runtime'))
from protocol_compat import Coordinator
from protocol_http import application
from protocol_compat_test import Backend, until

APP = Path(__file__).parents[1]


class IngressTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_ingress_denies_alternates_and_serializes_two_callers(self):
        binary = os.environ.get('NGINX_BINARY') or shutil.which('nginx') or '/usr/sbin/nginx'
        self.assertTrue(Path(binary).is_file(), 'Install nginx for offline ingress qualification')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backend = Backend()
            owner = Coordinator(backend, root / 'runs.sqlite', poll_interval=.001)
            server = TestServer(application(owner, 'offline-ingress-key'))
            await server.start_server()
            process = None
            try:
                subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                                '-keyout', str(root / 'tls.key'), '-out', str(root / 'tls.crt'),
                                '-days', '1', '-subj', '/CN=localhost'], check=True, capture_output=True)
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    port = sock.getsockname()[1]
                source = (APP / 'desktop/nginx.conf').read_text()
                source = source.replace('/run/user/1000', str(root))
                source = source.replace('listen 8443 ssl;', f'listen 127.0.0.1:{port} ssl;')
                source = source.replace('include /etc/nginx/mime.types;', 'types { text/html html; }')
                source = source.replace('127.0.0.1:8642', f'127.0.0.1:{server.port}')
                (root / 'nginx.conf').write_text(source)
                process = await asyncio.create_subprocess_exec(
                    binary, '-p', str(root), '-c', str(root / 'nginx.conf'),
                    '-g', 'daemon off;', stderr=asyncio.subprocess.PIPE)
                async with ClientSession() as client:
                    base = f'https://127.0.0.1:{port}'
                    async def ready():
                        for _ in range(200):
                            if process.returncode is not None:
                                raise AssertionError((await process.stderr.read()).decode())
                            try:
                                async with client.get(base + '/v1/runs/x', ssl=False) as response:
                                    return
                            except OSError:
                                await asyncio.sleep(.01)
                        raise AssertionError('nginx startup timed out')
                    await ready()
                    headers = {'Authorization': 'Bearer offline-ingress-key'}
                    # Every alternate native inference family, including profile mirrors.
                    paths = ['/v1/chat/completions', '/v1/responses',
                             '/api/sessions/s/chat', '/api/sessions/s/chat/stream',
                             '/api/jobs', '/api/jobs/j/run', '/api/cron/fire',
                             '/api/platforms/slack/events', '/p/default/v1/runs',
                             '/p/default/v1/chat/completions', '/api/sessions',
                             '/v1/runs/run_x/steer/extra']
                    for path in paths:
                        async with client.post(base + path, json={}, headers=headers, ssl=False) as response:
                            self.assertEqual(response.status, 403, path)
                    async with client.post(base + '/v1/runs', json={'input': 'a'}, ssl=False) as response:
                        self.assertEqual(response.status, 401)
                    async def create(key):
                        async with client.post(base + '/v1/runs', json={'input': key},
                                               headers=dict(headers, **{'Idempotency-Key': key,
                                                                        'X-Hermes-Session-Key': key}),
                                               ssl=False) as response:
                            self.assertEqual(response.status, 202)
                            return (await response.json())['run_id']
                    a, b = await asyncio.gather(create('desktop-caller'), create('orchestrator-caller'))
                    await until(lambda: len(backend.invocations) == 1)
                    await asyncio.sleep(.02)
                    self.assertEqual(len(backend.invocations), 1)
                    self.assertEqual(sorted(r.status['status'] for r in owner.runs.values()), ['queued', 'running'])
                    backend.finish('native0')
                    await until(lambda: len(backend.invocations) == 2)
                    self.assertEqual({x[1] for x in backend.invocations}, {'desktop-caller', 'orchestrator-caller'})
                    self.assertNotEqual(a, b)
            finally:
                if process and process.returncode is None:
                    process.terminate()
                    await asyncio.wait_for(process.communicate(), 5)
                await server.close()
                await owner.close()

    def test_supervision_single_owner_private_native_port_and_cleanup(self):
        services = APP / 's6-rc.d'
        self.assertEqual((services / 'hermes-compat/type').read_text().strip(), 'longrun')
        self.assertTrue((services / 'hermes-compat/dependencies.d/hermes-api').exists())
        self.assertTrue((services / 'user/contents.d/hermes-compat').exists())
        run = (services / 'hermes-compat/run').read_text()
        self.assertIn('exec /command/s6-setuidgid hermes /opt/hermes/.venv/bin/python', run)
        self.assertEqual(run.count('protocol_http.py'), 1)
        nginx = (APP / 'desktop/nginx.conf').read_text()
        self.assertIn('proxy_pass http://127.0.0.1:8642;', nginx)
        self.assertNotIn('8643', nginx)
        self.assertEqual(sum(p.read_text().count('protocol_http.py') for p in services.glob('*/run')), 1)
