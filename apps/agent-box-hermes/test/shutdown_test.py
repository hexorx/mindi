"""Exercise the production SIGTERM path with an open, nonterminal SSE client."""
import asyncio
import hashlib
import os
from pathlib import Path
import signal
import socket
import sys
import tempfile
import time
import unittest
from aiohttp import ClientSession, web
from aiohttp.test_utils import TestServer
sys.path.insert(0, str(Path(__file__).parents[1] / 'runtime'))
from protocol_compat import Coordinator, ProtocolError
from protocol_compat_test import Backend


class ShutdownTests(unittest.IsolatedAsyncioTestCase):
    async def test_sigterm_stops_native_before_exit_and_retains_reservation(self):
        stopped = asyncio.Event()
        release = asyncio.Event()
        creates = []
        async def native(request):
            if request.path == '/v1/runs':
                creates.append(1)
                return web.json_response({'run_id': 'run_native'})
            if request.path.endswith('/stop'):
                stopped.set()
                # Stop acknowledgement is deliberately lost. Shutdown must still
                # exit within its budget and leave ownership for reconciliation.
                await release.wait()
                return web.json_response({})
            if request.path.endswith('/events'):
                response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
                await response.prepare(request)
                await response.write(b'event: message.delta\ndata: {"delta":"partial"}\n\n')
                await release.wait()
                return response
            return web.json_response({'status': 'running', 'output': 'partial'})
        app = web.Application()
        app.router.add_route('*', '/{tail:.*}', native)
        server = TestServer(app)
        await server.start_server()
        try:
            with tempfile.TemporaryDirectory() as directory:
                journal = Path(directory) / 'runs.sqlite'
                with socket.socket() as sock:
                    sock.bind(('127.0.0.1', 0))
                    port = sock.getsockname()[1]
                env = dict(os.environ, API_SERVER_KEY='offline-shutdown-key',
                           HERMES_COMPAT_JOURNAL=str(journal))
                runtime = str(Path(__file__).parents[1] / 'runtime')
                env['PYTHONPATH'] = runtime + os.pathsep + env.get('PYTHONPATH', '')
                child = await asyncio.create_subprocess_exec(
                    sys.executable, '-B', '-c',
                    f'from protocol_http import main; main(port={port}, native_port={server.port})',
                    env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                try:
                    async with ClientSession() as client:
                        base = f'http://127.0.0.1:{port}'
                        headers = {'Authorization': 'Bearer offline-shutdown-key', 'Idempotency-Key': 'one'}
                        for _ in range(200):
                            try:
                                async with client.get(base + '/health', headers=headers):
                                    break
                            except OSError:
                                await asyncio.sleep(.025)
                        else:
                            self.fail('shim did not start')
                        async with client.post(base + '/v1/runs', headers=headers, json={'input': 'offline'}) as response:
                            run_id = (await response.json())['run_id']
                        async with client.get(base + '/v1/runs/' + run_id + '/events', headers=headers) as stream:
                            self.assertEqual(await asyncio.wait_for(stream.content.readline(), 3), b'id: 1\n')
                            started = time.monotonic()
                            child.send_signal(signal.SIGTERM)
                            await asyncio.wait_for(stopped.wait(), 3)
                            await asyncio.wait_for(child.wait(), 8)
                            self.assertLess(time.monotonic() - started, 10)
                            self.assertEqual(child.returncode, 0, (await child.stderr.read()).decode())
                    owner = Coordinator(Backend(), journal)
                    try:
                        scope = hashlib.sha256(b'offline-shutdown-key').hexdigest()
                        self.assertTrue(owner.status(scope, run_id)['event_gap'])
                        self.assertTrue(owner.recovery_required)
                        self.assertEqual(owner.create(scope, 'one', {'input': 'offline'})['run_id'], run_id)
                        with self.assertRaises(ProtocolError):
                            owner.create(scope, 'two', {'input': 'second'})
                        self.assertEqual(creates, [1])
                    finally:
                        await owner.close()
                finally:
                    if child.returncode is None:
                        child.kill()
                        await child.wait()
        finally:
            release.set()
            await server.close()
