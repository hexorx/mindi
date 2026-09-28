"""Supervised loopback compatibility API.

Run with the Hermes venv (aiohttp is already a gateway dependency). Only /v1/runs
is admitted for inference; alternate inference APIs must not bypass this slot.
Do not expose the native gateway port through nginx when enabling this service.
"""
import asyncio
import hashlib
import hmac
import json
import os
from pathlib import Path

from protocol_compat import Coordinator, ProtocolError


MAX_RESPONSE = 256 * 1024
MAX_FRAME = 64 * 1024


class Gateway:
    def __init__(self, client, base, key, *, max_response=MAX_RESPONSE, max_frame=MAX_FRAME):
        self.client, self.base, self.key = client, base, key
        self.max_response, self.max_frame = max_response, max_frame

    async def request(self, method, path, **kwargs):
        from aiohttp import ClientTimeout
        headers = {'Authorization': 'Bearer ' + self.key}
        headers.update(kwargs.pop('headers', {}))
        async with self.client.request(method, self.base + path, headers=headers,
                                       timeout=ClientTimeout(total=15), allow_redirects=False,
                                       auto_decompress=False, **kwargs) as response:
            if response.status >= 300:
                raise ProtocolError(502, 'gateway_request_failed')
            if response.headers.get('Content-Encoding', 'identity') != 'identity':
                raise ProtocolError(502, 'gateway_encoding_rejected')
            if response.content_length is not None and response.content_length > self.max_response:
                raise ProtocolError(502, 'gateway_response_too_large')
            body = bytearray()
            async for chunk in response.content.iter_chunked(4096):
                if len(body) + len(chunk) > self.max_response:
                    raise ProtocolError(502, 'gateway_response_too_large')
                body.extend(chunk)
            try:
                result = json.loads(body)
                if not isinstance(result, dict):
                    raise ValueError()
                if len(json.dumps(result).encode()) > self.max_response:
                    raise ProtocolError(502, 'gateway_response_too_large')
                return result
            except (ValueError, RecursionError):
                raise ProtocolError(502, 'gateway_response_invalid') from None

    async def create(self, body, session):
        headers = {'X-Hermes-Session-Key': session} if session else {}
        result = await self.request('POST', '/v1/runs', json=body, headers=headers)
        run_id = result.get('run_id')
        if not isinstance(run_id, str) or not run_id.startswith('run_') or not run_id[4:].isalnum():
            raise ProtocolError(502, 'gateway_run_id_invalid')
        return run_id

    async def status(self, run_id):
        return await self.request('GET', '/v1/runs/' + run_id)

    async def stop(self, run_id):
        # A terminal run no longer has an active agent in Hermes 0.20.4.
        status = await self.status(run_id)
        if status.get('status') in ('completed', 'failed', 'cancelled'):
            return status
        try:
            return await self.request('POST', '/v1/runs/' + run_id + '/stop')
        except ProtocolError:
            # Completion can race the preliminary status read and native stop.
            status = await self.status(run_id)
            if status.get('status') in ('completed', 'failed', 'cancelled'):
                return status
            raise

    async def events(self, run_id):
        from aiohttp import ClientTimeout
        headers = {'Authorization': 'Bearer ' + self.key, 'Accept': 'text/event-stream'}
        async with self.client.get(self.base + '/v1/runs/' + run_id + '/events',
                                   headers=headers, timeout=ClientTimeout(total=None, sock_read=45),
                                   allow_redirects=False, auto_decompress=False) as response:
            if response.status != 200:
                raise ProtocolError(502, 'upstream_events_unavailable')
            if response.headers.get('Content-Encoding', 'identity') != 'identity':
                raise ProtocolError(502, 'gateway_encoding_rejected')
            pending = bytearray()
            data, event_name, frame_bytes = [], 'message', 0
            async for chunk in response.content.iter_chunked(4096):
                pending.extend(chunk)
                while b'\n' in pending:
                    raw, _, remainder = pending.partition(b'\n')
                    pending = bytearray(remainder)
                    frame_bytes += len(raw) + 1
                    if frame_bytes > self.max_frame:
                        raise ProtocolError(502, 'gateway_frame_too_large')
                    line = raw.decode('utf-8').rstrip('\r')
                    if not line:
                        if data:
                            event = json.loads('\n'.join(data))
                            event.setdefault('event', event_name)
                            yield event
                        data, event_name, frame_bytes = [], 'message', 0
                    elif line.startswith('data:'):
                        data.append(line[5:].lstrip())
                    elif line.startswith('event:'):
                        event_name = line[6:].strip()
                if frame_bytes + len(pending) > self.max_frame:
                    raise ProtocolError(502, 'gateway_frame_too_large')
            if pending or data:
                raise ProtocolError(502, 'gateway_frame_incomplete')


def application(coordinator, key):
    from aiohttp import web
    scope = hashlib.sha256(key.encode()).hexdigest()

    def redact(value):
        if isinstance(value, str):
            return value.replace(key, '[REDACTED]')
        if isinstance(value, list):
            return [redact(item) for item in value]
        if isinstance(value, dict):
            return {redact(k): redact(v) for k, v in value.items()}
        return value

    @web.middleware
    async def boundary(request, handler):
        supplied = request.headers.get('Authorization', '')
        if not hmac.compare_digest(supplied.encode(), ('Bearer ' + key).encode()):
            return web.json_response({'error': 'unauthorized'}, status=401)
        try:
            return await handler(request)
        except web.HTTPException:
            raise
        except ProtocolError as error:
            return web.json_response({'error': error.code}, status=error.status)
        except (ValueError, TypeError):
            return web.json_response({'error': 'invalid_request'}, status=400)
        except Exception:
            return web.json_response({'error': 'gateway_unavailable'}, status=502)

    async def health(request):
        status = await coordinator.backend.request('GET', request.path)
        if coordinator.recovery_required:
            return web.json_response({'status': 'unhealthy', 'error': 'recovery_required'}, status=503)
        return web.json_response(redact(status))

    async def control(request):
        run = coordinator.lookup(scope, request.match_info['run_id'])
        if run.status['status'] in ('queued', 'starting', 'unknown') or not run.remote_id:
            raise ProtocolError(409, 'run_not_active')
        if run.status['status'] in ('completed', 'failed', 'cancelled', 'timeout'):
            raise ProtocolError(409, 'run_not_active')
        body = await request.json()
        if not isinstance(body, dict):
            raise ProtocolError(400, 'invalid_request')
        result = await coordinator.backend.request(
            'POST', '/v1/runs/' + run.remote_id + '/' + request.match_info['action'], json=body)
        return web.json_response(redact(result))

    async def create(request):
        body = await request.json()
        if not isinstance(body, dict) or not body.get('input'):
            raise ProtocolError(400, 'input_required')
        status = coordinator.create(scope, request.headers.get('Idempotency-Key', ''), body,
                                    request.headers.get('X-Hermes-Session-Key', ''))
        return web.json_response(redact(status), status=202)

    async def stop_reservation(request):
        body = await request.json()
        if not isinstance(body, dict) or not body.get('input'):
            raise ProtocolError(400, 'input_required')
        status = await coordinator.stop_reservation(
            scope, request.headers.get('Idempotency-Key', ''), body,
            request.headers.get('X-Hermes-Session-Key', ''))
        return web.json_response(redact(dict(status, reservation_cancelled=True)))

    async def status(request):
        return web.json_response(redact(coordinator.status(scope, request.match_info['run_id'])))

    async def stop(request):
        return web.json_response(redact(await coordinator.stop(scope, request.match_info['run_id'])))

    async def events(request):
        run_id = request.match_info['run_id']
        after = int(request.headers.get('Last-Event-ID', '0'))
        run = coordinator.lookup(scope, run_id)
        oldest = run.events[0][0] if run.events else run.next_event
        if after < oldest - 1 or after >= run.next_event:
            coordinator._gap(run)
            raise ProtocolError(409, 'event_cursor_unavailable')
        response = web.StreamResponse(headers={'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache'})
        await response.prepare(request)
        try:
            async for sequence, event in coordinator.events(scope, run_id, after):
                event = redact(event)
                name = str(event.get('event', 'message')).replace('\n', '').replace('\r', '')
                frame = f'id: {sequence}\nevent: {name}\ndata: {json.dumps(event)}\n\n'
                await response.write(frame.encode())
        except ProtocolError as error:
            await response.write(('event: compatibility.gap\ndata: ' + json.dumps({'error': error.code}) + '\n\n').encode())
        except (ConnectionError, asyncio.CancelledError):
            pass  # Downstream disconnect never cancels the shared collector.
        return response

    app = web.Application(middlewares=[boundary], client_max_size=256 * 1024)
    for path in ('/health', '/health/detailed', '/v1/health'):
        app.router.add_get(path, health)
    app.router.add_post('/v1/runs/{run_id}/{action:approval|steer}', control)
    app.router.add_post('/v1/runs', create)
    app.router.add_post('/v1/run-reservations/stop', stop_reservation)
    app.router.add_get('/v1/runs/{run_id}', status)
    app.router.add_post('/v1/runs/{run_id}/stop', stop)
    app.router.add_get('/v1/runs/{run_id}/events', events)
    return app


def main():
    from aiohttp import ClientSession, web
    key = os.environ.get('API_SERVER_KEY', '')
    if len(key.strip()) < 16 or len(key) > 8192 or any(c in key for c in '\r\n\0'):
        raise SystemExit('compatibility API: invalid API_SERVER_KEY (redacted)')
    journal = Path(os.environ.get('HERMES_COMPAT_JOURNAL', '/home/agent/.hermes/compat/runs.sqlite'))
    journal.parent.mkdir(mode=0o700, parents=True, exist_ok=True)

    async def start():
        client = ClientSession(read_bufsize=8192)
        # Fixed loopback upstream; callers cannot choose a request destination.
        coordinator = Coordinator(Gateway(client, 'http://127.0.0.1:8643', key), journal)
        async def recover():
            while True:
                if coordinator.recovery_required:
                    await coordinator.reconcile()
                await asyncio.sleep(1)
        recovery = asyncio.create_task(recover())
        app = application(coordinator, key)
        async def cleanup(_app):
            recovery.cancel()
            await asyncio.gather(recovery, return_exceptions=True)
            await coordinator.close()
            await client.close()
        app.on_cleanup.append(cleanup)
        return app
    web.run_app(start(), host='127.0.0.1', port=8642, access_log=None, print=None)


if __name__ == '__main__':
    main()
