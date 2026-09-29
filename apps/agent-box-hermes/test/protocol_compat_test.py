import asyncio
from pathlib import Path
import sys
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).parents[1] / 'runtime'))
from protocol_compat import Coordinator, ProtocolError


class Backend:
    def __init__(self):
        self.invocations = []
        self.states = {}
        self.streams = {}
        self.stops = []
        self.creating = asyncio.Event()
        self.release_create = asyncio.Event()
        self.release_create.set()
        self.fail_create = False
        self.fail_stop = False
        self.readers = 0

    async def create(self, body, session):
        remote = 'native' + str(len(self.invocations))
        self.invocations.append((body, session))
        self.states[remote] = {'status': 'running'}
        self.streams[remote] = asyncio.Queue()
        self.creating.set()
        await self.release_create.wait()
        if self.fail_create:
            raise OSError('ambiguous response')
        return remote

    async def status(self, remote):
        return dict(self.states[remote])

    async def stop(self, remote):
        self.stops.append(remote)
        if self.fail_stop:
            raise OSError('stop failed')
        return {'status': 'stopping'}

    async def events(self, remote):
        self.readers += 1
        while True:
            event = await self.streams[remote].get()
            if event is None:
                return
            yield event

    def finish(self, remote, status='completed'):
        self.states[remote] = {'status': status, 'output': 'final output', 'usage': {'input_tokens': 2}}
        self.streams[remote].put_nowait({'event': 'run.' + status})
        self.streams[remote].put_nowait(None)


async def until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(.001)


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.journal = Path(self.temp.name) / 'runs.sqlite'
        self.backend = Backend()
        self.coordinator = Coordinator(self.backend, self.journal, poll_interval=.001)
        self.addAsyncCleanup(self.coordinator.close)

    def create(self, key, scope='caller-a'):
        return self.coordinator.create(scope, key, {'input': key})['run_id']

    async def test_concurrent_repeated_keys_invoke_once_and_conflicts_reject(self):
        async def request():
            return self.create('one')
        ids = await asyncio.gather(*(request() for _ in range(25)))
        await self.backend.creating.wait()
        self.assertEqual(len(set(ids)), 1)
        self.assertEqual(len(self.backend.invocations), 1)
        with self.assertRaises(ProtocolError) as caught:
            self.coordinator.create('caller-a', 'one', {'input': 'different'})
        self.assertEqual(caught.exception.status, 409)
        self.backend.finish('native0')
        await until(lambda: self.coordinator.status('caller-a', ids[0])['status'] == 'completed')
        self.assertEqual(self.create('one'), ids[0])
        self.assertEqual(len(self.backend.invocations), 1)
        self.assertEqual(self.coordinator.status('caller-a', ids[0])['usage'], {'input_tokens': 2})

    async def test_box_slot_serializes_distinct_callers_until_actual_terminal(self):
        first = self.create('one')
        second = self.create('two', 'caller-b')
        await self.backend.creating.wait()
        await self.coordinator.stop('caller-a', first)
        await asyncio.sleep(.01)
        self.assertEqual(len(self.backend.invocations), 1)
        self.assertEqual(self.coordinator.status('caller-b', second)['status'], 'queued')
        self.backend.finish('native0', 'cancelled')
        await until(lambda: len(self.backend.invocations) == 2)
        self.assertEqual(self.backend.invocations[1][0]['input'], 'two')
        with self.assertRaises(ProtocolError):
            self.coordinator.status('caller-a', second)

    async def test_queued_cancel_and_timeout_do_not_invoke_or_leak_slot(self):
        self.coordinator.queue_timeout = .02
        self.create('first')
        second = self.create('cancel')
        third = self.create('expire')
        await self.backend.creating.wait()
        await self.coordinator.stop('caller-a', second)
        await until(lambda: self.coordinator.status('caller-a', third)['status'] == 'timeout')
        self.backend.finish('native0')
        fourth = self.create('fourth')
        await until(lambda: len(self.backend.invocations) == 2)
        self.assertEqual([x[0]['input'] for x in self.backend.invocations], ['first', 'fourth'])
        self.assertNotEqual(fourth, third)

    async def test_cancel_during_create_waits_for_id_then_stops(self):
        self.backend.release_create.clear()
        first = self.create('first')
        self.create('second')
        await self.backend.creating.wait()
        await self.coordinator.stop('caller-a', first)
        self.assertEqual(self.backend.stops, [])
        self.backend.release_create.set()
        await until(lambda: bool(self.backend.stops))
        self.assertEqual(self.backend.stops, ['native0'])
        self.assertEqual(len(self.backend.invocations), 1)
        self.backend.finish('native0', 'cancelled')
        await until(lambda: len(self.backend.invocations) == 2)
        await self.coordinator.stop('caller-a', first)
        self.assertEqual(self.backend.stops, ['native0'])

    async def test_failed_stop_and_failed_run_release_only_on_terminal(self):
        first = self.create('first')
        self.create('second')
        await self.backend.creating.wait()
        await until(lambda: self.coordinator.runs[first].remote_id is not None)
        self.backend.fail_stop = True
        with self.assertRaises(OSError):
            await self.coordinator.stop('caller-a', first)
        self.assertEqual(len(self.backend.invocations), 1)
        self.backend.finish('native0', 'failed')
        await until(lambda: len(self.backend.invocations) == 2)

    async def test_ambiguous_create_holds_slot_and_retry_never_reinvokes(self):
        self.backend.fail_create = True
        first = self.create('first')
        self.create('second')
        await until(lambda: self.coordinator.recovery_required)
        self.assertEqual(self.create('first'), first)
        self.assertEqual(len(self.backend.invocations), 1)
        with self.assertRaises(ProtocolError):
            self.create('third')

    async def test_reconnect_replays_ordered_events_without_new_inference(self):
        run_id = self.create('first')
        await self.backend.creating.wait()
        stream = self.coordinator.events('caller-a', run_id)
        self.backend.streams['native0'].put_nowait({'event': 'message.delta', 'delta': 'a'})
        self.assertEqual((await anext(stream))[0], 1)
        await stream.aclose()
        self.backend.streams['native0'].put_nowait({'event': 'message.delta', 'delta': 'b'})
        await until(lambda: len(self.coordinator.runs[run_id].events) == 2)
        second = self.coordinator.events('caller-a', run_id, after=1)
        observer = self.coordinator.events('caller-a', run_id, after=1)
        self.assertEqual((await anext(second))[1]['delta'], 'b')
        self.assertEqual((await anext(observer))[1]['delta'], 'b')
        self.backend.finish('native0')
        self.assertEqual((await anext(second))[1]['event'], 'run.completed')
        await second.aclose()
        await observer.aclose()
        self.assertEqual(self.backend.readers, 1)
        self.assertEqual(len(self.backend.invocations), 1)

    async def test_expired_cursor_is_an_explicit_gap(self):
        self.coordinator.max_event_bytes = 1
        run_id = self.create('first')
        await self.backend.creating.wait()
        self.backend.streams['native0'].put_nowait({'event': 'message.delta'})
        await until(lambda: self.coordinator.runs[run_id].next_event == 2)
        with self.assertRaises(ProtocolError) as caught:
            await anext(self.coordinator.events('caller-a', run_id))
        self.assertEqual(caught.exception.code, 'event_cursor_expired')

    async def test_journal_is_exclusively_owned_and_restart_retains_reservation(self):
        run_id = self.create('first')
        await self.backend.creating.wait()
        with self.assertRaises(BlockingIOError):
            Coordinator(self.backend, self.journal)
        await self.coordinator.close()
        # Replace cleanup target with the newly opened owner.
        self.coordinator = Coordinator(self.backend, self.journal)
        self.addAsyncCleanup(self.coordinator.close)
        self.assertEqual(self.create('first'), run_id)
        with self.assertRaises(ProtocolError) as caught:
            self.create('second')
        self.assertEqual(caught.exception.code, 'recovery_required')
        self.assertEqual(len(self.backend.invocations), 1)


if __name__ == '__main__':
    unittest.main()
