"""Offline qualification: resource budgets, transport faults and restart."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock
from aiohttp import ClientSession, web
from aiohttp.test_utils import TestClient, TestServer
sys.path.insert(0, str(Path(__file__).parents[1] / 'runtime'))
from protocol_compat import Coordinator, ProtocolError
from protocol_http import Gateway, application
from protocol_compat_test import Backend, until


class QualificationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.journal = Path(temp.name) / 'runs.sqlite'
        self.backend = Backend()
        self.owner = Coordinator(self.backend, self.journal, poll_interval=.001,
                                 max_replay_bytes=2048, max_replay_events=10)
        self.addAsyncCleanup(self.owner.close)

    async def test_process_budget_across_concurrent_callers_and_cursor_loss(self):
        ids = [self.owner.create(str(i), str(i), {'input': 'x'})['run_id'] for i in range(20)]
        async def emit(run_id):
            for _ in range(20):
                self.owner._append(self.owner.runs[run_id], {'event': 'delta', 'data': 'x' * 100})
                self.assertLessEqual(self.owner.replay_bytes, 2048)
                self.assertLessEqual(len(self.owner.replay), 10)
                await asyncio.sleep(0)
        await asyncio.gather(*(emit(i) for i in ids))
        self.assertEqual(self.owner.replay_bytes, sum(r.event_bytes for r in self.owner.runs.values()))
        for i, run_id in enumerate(ids):
            with self.assertRaises(ProtocolError) as error:
                await anext(self.owner.events(str(i), run_id))
            self.assertEqual(error.exception.code, 'event_cursor_expired')
            self.assertTrue(self.owner.status(str(i), run_id)['event_gap'])

    async def test_count_budget_for_tiny_events_and_reservation_backpressure(self):
        self.owner.max_replay_bytes = 10**6
        self.owner.max_runs = 2
        run = self.owner.create('a', 'a', {'input': 'a'})['run_id']
        self.owner.create('b', 'b', {'input': 'b'})
        for _ in range(100):
            self.owner._append(self.owner.runs[run], {})
        self.assertEqual(len(self.owner.replay), 10)
        with self.assertRaises(ProtocolError) as error:
            self.owner.create('c', 'c', {'input': 'c'})
        self.assertEqual(error.exception.code, 'journal_capacity')

    async def test_snapshot_limit_rejects_before_dispatch(self):
        self.owner.max_snapshot_bytes = 512
        with self.assertRaises(ProtocolError) as error:
            self.owner.create('a', 'a', {'input': 'x' * 1024})
        self.assertEqual(error.exception.code, 'snapshot_too_large')
        self.assertEqual(self.backend.invocations, [])
        self.assertEqual(self.owner.db.execute('SELECT count(*) FROM runs').fetchone()[0], 0)

    async def test_connection_loss_mid_emission_keeps_output_and_sticky_gap(self):
        run = self.owner.create('a', 'a', {'input': 'a'})['run_id']
        await self.backend.creating.wait()
        self.backend.streams['native0'].put_nowait({'event': 'message.delta', 'delta': 'partial'})
        await until(lambda: self.owner.runs[run].next_event == 2)
        self.backend.streams['native0'].put_nowait(None)
        await until(lambda: self.owner.runs[run].event_gap)
        self.backend.states['native0'] = {'status': 'completed', 'output': 'partial kept', 'event_gap': False}
        await until(lambda: self.owner.status('a', run)['status'] == 'completed')
        self.assertEqual(self.owner.status('a', run)['output'], 'partial kept')
        self.assertTrue(self.owner.status('a', run)['event_gap'])

    async def test_restart_stops_orphan_keeps_reservation_and_never_redispatches(self):
        run = self.owner.create('a', 'a', {'input': 'a'})['run_id']
        await until(lambda: self.owner.runs[run].remote_id is not None)
        await self.owner.close()
        replacement = Coordinator(self.backend, self.journal)
        self.addAsyncCleanup(replacement.close)
        self.assertTrue(replacement.status('a', run)['event_gap'])
        self.assertEqual(replacement.status('a', run)['status'], 'unknown')
        await replacement.reconcile()
        self.assertTrue(replacement.recovery_required)  # Stop acknowledgement is not termination.
        self.assertEqual(self.backend.stops, ['native0', 'native0'])
        with self.assertRaises(ProtocolError):
            replacement.create('a', 'b', {'input': 'b'})
        self.backend.finish('native0', 'cancelled')
        await replacement.reconcile()
        self.assertFalse(replacement.recovery_required)
        self.assertEqual(replacement.status('a', run)['status'], 'failed')
        self.assertEqual(replacement.status('a', run)['output'], 'final output')
        self.assertTrue(replacement.status('a', run)['event_gap'])
        self.assertEqual(replacement.create('a', 'a', {'input': 'a'})['run_id'], run)
        self.assertEqual(len(self.backend.invocations), 1)
        self.assertEqual(replacement.db.execute('SELECT count(*) FROM runs').fetchone()[0], 1)

    async def test_restart_unknown_create_cannot_release_or_redispatch(self):
        self.backend.fail_create = True
        run = self.owner.create('a', 'a', {'input': 'a'})['run_id']
        await until(lambda: self.owner.recovery_required)
        await self.owner.close()
        replacement = Coordinator(self.backend, self.journal)
        self.addAsyncCleanup(replacement.close)
        await replacement.reconcile()
        self.assertTrue(replacement.recovery_required)
        self.assertTrue(replacement.status('a', run)['event_gap'])
        self.assertEqual(replacement.create('a', 'a', {'input': 'a'})['run_id'], run)
        self.assertEqual(len(self.backend.invocations), 1)


class TransportLimits(unittest.IsolatedAsyncioTestCase):
    async def gateway(self, handler):
        app = web.Application()
        app.router.add_route('*', '/{tail:.*}', handler)
        server = TestServer(app)
        await server.start_server()
        self.addAsyncCleanup(server.close)
        client = ClientSession(read_bufsize=8192)
        self.addAsyncCleanup(client.close)
        return Gateway(client, str(server.make_url('')).rstrip('/'), 'fixture-secret', max_response=1024, max_frame=128)

    async def test_chunked_and_declared_response_limits(self):
        for chunked in (False, True):
            async def handler(request):
                if not chunked:
                    return web.Response(body=b'x' * 1025)
                response = web.StreamResponse()
                await response.prepare(request)
                await response.write(b'x' * 600)
                await response.write(b'x' * 600)
                return response
            gateway = await self.gateway(handler)
            with self.assertRaises(ProtocolError) as error:
                await gateway.status('run_a')
            self.assertEqual(error.exception.code, 'gateway_response_too_large')

    async def test_oversized_error_is_not_read_or_exposed(self):
        async def handler(request):
            return web.Response(status=500, text='fixture-secret' * 1000)
        gateway = await self.gateway(handler)
        with self.assertRaises(ProtocolError) as error:
            await gateway.status('run_a')
        self.assertEqual(error.exception.code, 'gateway_request_failed')
        self.assertNotIn('fixture-secret', str(error.exception))

    async def test_sse_limits_both_unterminated_lines_and_multiline_frames(self):
        for body in (b'data: ' + b'x' * 200, b'data: x\n' * 30):
            async def handler(request):
                response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
                await response.prepare(request)
                for offset in range(0, len(body), 17):
                    await response.write(body[offset:offset + 17])
                return response
            gateway = await self.gateway(handler)
            with self.assertRaises(ProtocolError) as error:
                await anext(gateway.events('run_a'))
            self.assertEqual(error.exception.code, 'gateway_frame_too_large')

    async def test_compressed_and_redirect_responses_rejected(self):
        for status, headers in ((200, {'Content-Encoding': 'gzip'}), (302, {'Location': '/secret'})):
            async def handler(request):
                return web.Response(status=status, headers=headers, body=b'{}')
            gateway = await self.gateway(handler)
            with self.assertRaises(ProtocolError):
                await gateway.status('run_a')


class ControlRoutes(unittest.IsolatedAsyncioTestCase):
    async def test_authenticated_health_and_controls_use_owned_native_id(self):
        with tempfile.TemporaryDirectory() as directory:
            backend = Backend()
            backend.request = AsyncMock(return_value={'status': 'healthy', 'value': 'fixture-secret'})
            owner = Coordinator(backend, Path(directory) / 'runs.sqlite', poll_interval=.001)
            self.addAsyncCleanup(owner.close)
            client = TestClient(TestServer(application(owner, 'fixture-secret')))
            await client.start_server()
            self.addAsyncCleanup(client.close)
            headers = {'Authorization': 'Bearer fixture-secret', 'Idempotency-Key': 'a'}
            for path in ('/health', '/health/detailed', '/v1/health'):
                self.assertEqual((await client.get(path)).status, 401)
                result = await client.get(path, headers=headers)
                self.assertEqual((await result.json())['value'], '[REDACTED]')
            created = await client.post('/v1/runs', headers=headers, json={'input': 'x'})
            run = (await created.json())['run_id']
            await until(lambda: owner.runs[run].status['status'] == 'running')
            for action in ('approval', 'steer'):
                path = '/v1/runs/' + run + '/' + action
                self.assertEqual((await client.post(path, json={})).status, 401)
                response = await client.post(path, headers=headers, json={'value': 'continue'})
                self.assertEqual(response.status, 200)
                backend.request.assert_awaited_with('POST', '/v1/runs/native0/' + action, json={'value': 'continue'})
                self.assertEqual((await client.post('/v1/runs/native0/' + action, headers=headers, json={})).status, 404)
            self.assertEqual(len(backend.invocations), 1)
            owner.recovery_required = True
            self.assertEqual((await client.get('/health', headers=headers)).status, 503)
            await owner.close()
