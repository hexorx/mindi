"""Native gap sources through real HTTP Gateway/shim; downstream polling wins."""
import asyncio
import json
from pathlib import Path
import sys
import tempfile
from aiohttp import ClientSession, web
sys.path.insert(0, str(Path(__file__).parents[1] / 'runtime'))
from protocol_compat import Coordinator
from protocol_http import Gateway, application


async def main():
    source = sys.argv[1]
    complete = False
    native_status_seen = asyncio.Event()
    polls = 0
    downstream_events = 0

    async def create(request):
        return web.json_response({'run_id': 'run_native'})

    async def status(request):
        nonlocal polls
        polls += 1
        result = dict(status='completed' if complete else 'running',
                      output='authoritative output', usage={'input_tokens': 7})
        result['event_gap'] = source == 'status' and not complete
        native_status_seen.set()
        return web.json_response(result)

    async def events(request):
        nonlocal complete
        await native_status_seen.wait()
        response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
        await response.prepare(request)
        if source == 'event':
            await response.write(b'event: compatibility.gap\ndata: {}\n\n')
        elif source == 'payload':
            await response.write(b'event: message.delta\ndata: {"event_gap":true,"delta":"partial"}\n\n')
        await response.write(b'event: run.completed\ndata: {}\n\n')
        complete = True
        return response

    native = web.Application()
    native.router.add_post('/v1/runs', create)
    native.router.add_get('/v1/runs/run_native', status)
    native.router.add_get('/v1/runs/run_native/events', events)
    native_runner = web.AppRunner(native)
    await native_runner.setup()
    site = web.TCPSite(native_runner, '127.0.0.1', 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    with tempfile.TemporaryDirectory() as directory:
        async with ClientSession() as client:
            coordinator = Coordinator(Gateway(client, f'http://127.0.0.1:{port}', 'offline-contract-key'),
                                      Path(directory) / 'runs.sqlite', poll_interval=.001)
            app = application(coordinator, 'offline-contract-key')

            @web.middleware
            async def delay_downstream(request, handler):
                nonlocal downstream_events
                if request.path.endswith('/events'):
                    # Keep SSE pending until the adapter finishes via HTTP status.
                    downstream_events += 1
                    await asyncio.Event().wait()
                return await handler(request)

            app.middlewares.append(delay_downstream)

            async def evidence(request):
                snapshots = [json.loads(row[0]) for row in coordinator.db.execute('SELECT snapshot FROM runs')]
                return web.json_response(dict(snapshots=snapshots, polls=polls,
                                              downstream_events=downstream_events))

            app.router.add_get('/test/evidence', evidence)
            runner = web.AppRunner(app, shutdown_timeout=.01)
            await runner.setup()
            shim = web.TCPSite(runner, '127.0.0.1', 0)
            await shim.start()
            print('http://127.0.0.1:' + str(shim._server.sockets[0].getsockname()[1]), flush=True)
            try:
                await asyncio.Event().wait()
            finally:
                await runner.cleanup()
                await coordinator.close()
                await native_runner.cleanup()


asyncio.run(main())
