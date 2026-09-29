"""Loopback-only test fixture; fake backend never invokes a model or desktop.

Used by the adapter cross-repository contract test. No production entrypoint.
"""
import asyncio
from pathlib import Path
import sys
import tempfile
from aiohttp import web
sys.path.insert(0, str(Path(__file__).parents[1] / 'runtime'))
from protocol_compat import Coordinator
from protocol_http import application
from protocol_compat_test import Backend


async def main():
    scenario = sys.argv[1]
    with tempfile.TemporaryDirectory() as directory:
        backend = Backend()
        coordinator = Coordinator(backend, Path(directory) / 'runs.sqlite', queue_timeout=.03, poll_interval=.001)
        if scenario == 'expiry':
            coordinator.create('blocker', 'blocker', {'input': 'blocker'})
            await backend.creating.wait()
        else:
            original_stop = backend.stop
            async def stop(remote):
                await original_stop(remote)
                backend.finish(remote, 'cancelled')
                return {'status': 'stopping'}
            backend.stop = stop
        app = application(coordinator, 'offline-contract-key')
        @web.middleware
        async def stall_create(request, handler):
            if request.path != '/v1/runs' or request.method != 'POST' or scenario == 'expiry':
                return await handler(request)
            response = await handler(request)  # Reserve/invoke once, then lose response.
            if scenario == 'body':
                stalled = web.StreamResponse(status=202, headers={'Content-Type': 'application/json'})
                await stalled.prepare(request)
                await stalled.write(b'{')
            await asyncio.sleep(60)
            return response
        app.middlewares.insert(0, stall_create)
        async def counts(request):
            return web.json_response({'invocations': len(backend.invocations), 'stops': len(backend.stops),
                                      'bodies': [x[0] for x in backend.invocations]})
        app.router.add_get('/test/counts', counts)
        runner = web.AppRunner(app, shutdown_timeout=.01)
        await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0)
        await site.start()
        print('http://127.0.0.1:' + str(site._server.sockets[0].getsockname()[1]), flush=True)
        try:
            await asyncio.Event().wait()
        finally:
            await runner.cleanup()
            await coordinator.close()


asyncio.run(main())
