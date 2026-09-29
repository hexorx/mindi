"""Actual native TCP loss mid-SSE, real Gateway/shim, no inference."""
import asyncio
from pathlib import Path
import sys
import tempfile
from aiohttp import ClientSession, web
sys.path.insert(0, str(Path(__file__).parents[1] / 'runtime'))
from protocol_compat import Coordinator
from protocol_http import Gateway, application


async def main():
    complete = False
    async def create(request):
        return web.json_response({'run_id': 'run_native'})
    async def status(request):
        return web.json_response({'status': 'completed' if complete else 'running',
                                  'output': 'kept after native disconnect',
                                  'usage': {'input_tokens': 7}})
    async def events(request):
        nonlocal complete
        response = web.StreamResponse(headers={'Content-Type': 'text/event-stream'})
        await response.prepare(request)
        await response.write(b'event: message.delta\ndata: {"delta":"kept"}\n\n')
        await asyncio.sleep(.03)
        complete = True
        request.transport.close()  # Deliberately truncate chunked HTTP; no terminal event.
        return response
    native = web.Application()
    native.router.add_post('/v1/runs', create)
    native.router.add_get('/v1/runs/run_native', status)
    native.router.add_get('/v1/runs/run_native/events', events)
    native_runner = web.AppRunner(native)
    await native_runner.setup()
    site = web.TCPSite(native_runner, '127.0.0.1', 0)
    await site.start()
    native_port = site._server.sockets[0].getsockname()[1]
    with tempfile.TemporaryDirectory() as directory:
        async with ClientSession(read_bufsize=8192) as client:
            coordinator = Coordinator(Gateway(client, f'http://127.0.0.1:{native_port}', 'offline-contract-key'),
                                      Path(directory) / 'runs.sqlite', poll_interval=.001)
            runner = web.AppRunner(application(coordinator, 'offline-contract-key'), shutdown_timeout=.01)
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
