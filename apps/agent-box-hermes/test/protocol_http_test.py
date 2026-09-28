import asyncio
from pathlib import Path
import sys
import tempfile
import unittest
from aiohttp.test_utils import TestClient, TestServer
sys.path.insert(0, str(Path(__file__).parents[1] / 'runtime'))
from protocol_compat import Coordinator
from protocol_http import application
from protocol_compat_test import Backend, until


class HttpTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.backend = Backend()
        self.coordinator = Coordinator(self.backend, Path(temp.name) / 'runs.sqlite', poll_interval=.001)
        self.addAsyncCleanup(self.coordinator.close)
        self.key = 'offline-test-key-only'
        self.client = TestClient(TestServer(application(self.coordinator, self.key)))
        await self.client.start_server()
        self.addAsyncCleanup(self.client.close)
        self.headers = {'Authorization': 'Bearer ' + self.key, 'Idempotency-Key': 'one'}

    async def create(self):
        response = await self.client.post('/v1/runs', headers=self.headers, json={'input': 'offline'})
        self.assertEqual(response.status, 202)
        return (await response.json())['run_id']

    async def test_auth_dedup_conflict_and_alternate_route_denial(self):
        denied = await self.client.post('/v1/runs', json={'input': 'offline'})
        self.assertEqual(denied.status, 401)
        first, second = await asyncio.gather(self.create(), self.create())
        self.assertEqual(first, second)
        await self.backend.creating.wait()
        self.assertEqual(len(self.backend.invocations), 1)
        conflict = await self.client.post('/v1/runs', headers=self.headers, json={'input': 'changed'})
        self.assertEqual(conflict.status, 409)
        alternate = await self.client.post('/v1/chat/completions', headers=self.headers, json={})
        self.assertEqual(alternate.status, 404)
        missing = await self.client.get('/v1/runs/missing', headers=self.headers)
        self.assertEqual(missing.status, 404)

    async def test_http_reconnect_and_final_status_redaction(self):
        run_id = await self.create()
        await self.backend.creating.wait()
        self.backend.streams['native0'].put_nowait({'event': 'message.delta', 'delta': 'a'})
        path = '/v1/runs/' + run_id
        first = await self.client.get(path + '/events', headers=self.headers)
        self.assertEqual(await first.content.readline(), b'id: 1\n')
        first.close()
        self.backend.streams['native0'].put_nowait({'event': 'message.delta', 'delta': 'b'})
        second = await self.client.get(path + '/events', headers=dict(self.headers, **{'Last-Event-ID': '1'}))
        self.assertEqual(await second.content.readline(), b'id: 2\n')
        self.backend.finish('native0')
        self.backend.states['native0']['output'] = 'saved ' + self.key
        await until(lambda: self.coordinator.runs[run_id].status['status'] == 'completed')
        final = await self.client.get(path, headers=self.headers)
        self.assertEqual((await final.json())['output'], 'saved [REDACTED]')
        stop = await self.client.post(path + '/stop', headers=self.headers)
        self.assertEqual(stop.status, 200)
        self.assertEqual(self.backend.stops, [])
        self.assertEqual(self.backend.readers, 1)
        second.close()

    async def test_native_stop_completion_race_is_idempotent(self):
        from unittest.mock import AsyncMock
        from protocol_compat import ProtocolError
        from protocol_http import Gateway
        gateway = Gateway(None, 'http://unused', self.key)
        gateway.request = AsyncMock(side_effect=[{'status': 'running'}, ProtocolError(502, 'gateway_request_failed'), {'status': 'completed'}])
        self.assertEqual(await gateway.stop('run_fake'), {'status': 'completed'})
