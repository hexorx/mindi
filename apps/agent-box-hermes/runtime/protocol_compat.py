"""Offline-testable single-box run coordinator; transport supplies authenticated scope.

One process owns one durable journal for the lifetime of the gateway. A restart
with nonterminal work fails closed: terminal HTTP status alone cannot prove that
an orphaned desktop process stopped. No automatic re-dispatch or key eviction.
"""
import asyncio
import hashlib
import json
import os
import sqlite3
import uuid
from dataclasses import dataclass, field

TERMINAL = frozenset(('completed', 'failed', 'cancelled', 'timeout'))


class ProtocolError(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code


@dataclass
class Run:
    id: str
    scope: str
    key: str
    fingerprint: str
    body: dict
    session: str
    status: dict
    remote_id: str | None = None
    stop_requested: bool = False
    events: list = field(default_factory=list)
    changed: asyncio.Event = field(default_factory=asyncio.Event)
    next_event: int = 1
    event_bytes: int = 0
    event_gap: bool = False
    timer: object = None


class Coordinator:
    """Backend: create(body, session), status(id), stop(id), events(id).

    Backend events is an async iterator of parsed upstream event dictionaries.
    create failures are ambiguous and hold the slot; stop is a request, never
    proof of termination. Only observed terminal completion releases the slot.
    """
    def __init__(self, backend, journal, *, queue_timeout=300, poll_interval=.25,
                 max_runs=10000, max_event_bytes=4 * 1024 * 1024):
        import fcntl
        self.backend = backend
        self.queue_timeout = queue_timeout
        self.poll_interval = poll_interval
        self.max_runs = max_runs
        self.max_event_bytes = max_event_bytes
        self.lock = os.open(str(journal) + '.lock', os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BaseException:
            os.close(self.lock)
            raise
        fd = os.open(journal, os.O_CREAT | os.O_RDWR, 0o600)
        os.close(fd)
        self.db = sqlite3.connect(journal)
        self.db.execute('CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, snapshot TEXT NOT NULL)')
        self.runs = {}
        self.keys = {}
        self.queue = asyncio.Queue()
        self.worker = None
        self.closed = False
        for (snapshot,) in self.db.execute('SELECT snapshot FROM runs'):
            run = Run(**json.loads(snapshot))
            run.event_gap = True  # Event history is bounded in memory, not restored.
            run.status['event_gap'] = True
            self.runs[run.id] = run
            self.keys[(run.scope, run.key)] = run
        self.recovery_required = any(r.status['status'] not in TERMINAL for r in self.runs.values())

    def _save(self, run):
        # Never persist API keys. Request content is private runtime data.
        fields = ('id', 'scope', 'key', 'fingerprint', 'body', 'session', 'status', 'remote_id', 'stop_requested', 'event_gap')
        snapshot = {key: getattr(run, key) for key in fields}
        self.db.execute('INSERT OR REPLACE INTO runs VALUES (?, ?)', (run.id, json.dumps(snapshot)))
        self.db.commit()

    def _status(self, run, status, **extra):
        run.status = dict(extra, run_id=run.id, status=status, event_gap=run.event_gap)
        self._save(run)
        run.changed.set()

    def create(self, scope, key, body, session='', *, cancelled=False):
        if not scope or not key or len(key) > 256:
            raise ProtocolError(400, 'idempotency_key_required')
        canonical = json.dumps([body, session], sort_keys=True, separators=(',', ':'), allow_nan=False)
        fingerprint = hashlib.sha256(canonical.encode()).hexdigest()
        existing = self.keys.get((scope, key))
        if existing:
            if existing.fingerprint != fingerprint:
                raise ProtocolError(409, 'idempotency_conflict')
            return dict(existing.status)
        if self.closed or self.recovery_required:
            raise ProtocolError(503, 'recovery_required')
        if len(self.runs) >= self.max_runs:
            raise ProtocolError(503, 'journal_capacity')
        run = Run('run_' + uuid.uuid4().hex, scope, key, fingerprint,
                  json.loads(json.dumps(body)), session, {})
        self._status(run, 'cancelled' if cancelled else 'queued')  # Durable before dispatch.
        self.runs[run.id] = run
        self.keys[(scope, key)] = run
        if cancelled:
            return dict(run.status)
        run.timer = asyncio.get_running_loop().call_later(self.queue_timeout, self._expire, run)
        self.queue.put_nowait(run)
        if self.worker is None:
            self.worker = asyncio.create_task(self._work())
        return dict(run.status)

    def _expire(self, run):
        if run.status['status'] == 'queued':
            self._status(run, 'timeout', error='queue_timeout')

    def lookup(self, scope, run_id):
        run = self.runs.get(run_id)
        if run is None or run.scope != scope:
            raise ProtocolError(404, 'run_not_found')
        return run

    def status(self, scope, run_id):
        return dict(self.lookup(scope, run_id).status)

    async def stop(self, scope, run_id):
        run = self.lookup(scope, run_id)
        if run.status['status'] in TERMINAL:
            return dict(run.status)
        if run.status['status'] == 'queued':
            run.timer.cancel()
            self._status(run, 'cancelled')
        else:
            # Persist intent even if create has not returned the remote ID yet.
            run.stop_requested = True
            self._save(run)
            if run.remote_id:
                await self.backend.stop(run.remote_id)
        return dict(run.status)

    async def stop_reservation(self, scope, key, body, session=''):
        # An absent reservation becomes a durable cancellation tombstone. A late
        # create with this same fingerprint can never dispatch inference.
        status = self.create(scope, key, body, session, cancelled=True)
        return await self.stop(scope, status['run_id'])

    def _gap(self, run):
        run.event_gap = True
        run.status['event_gap'] = True
        self._save(run)
        run.changed.set()

    def _append(self, run, event):
        event = dict(event, run_id=run.id)
        size = len(json.dumps(event).encode())
        run.events.append((run.next_event, event, size))
        run.next_event += 1
        run.event_bytes += size
        while run.events and run.event_bytes > self.max_event_bytes:
            _, _, removed = run.events.pop(0)
            run.event_bytes -= removed
        run.changed.set()

    async def events(self, scope, run_id, after=0):
        run = self.lookup(scope, run_id)
        if after < 0 or after >= run.next_event:
            self._gap(run)
            raise ProtocolError(409, 'event_cursor_invalid')
        while True:
            run.changed.clear()
            oldest = run.events[0][0] if run.events else run.next_event
            if after < oldest - 1:
                self._gap(run)
                raise ProtocolError(409, 'event_cursor_expired')
            for sequence, event, _ in list(run.events):
                if sequence > after:
                    after = sequence
                    yield sequence, dict(event)
            if run.status['status'] in TERMINAL:
                if run.event_gap:
                    raise ProtocolError(409, 'upstream_event_gap')
                return
            await run.changed.wait()

    async def _collect(self, run):
        try:
            terminal_seen = False
            async for event in self.backend.events(run.remote_id):
                self._append(run, event)
                terminal_seen |= event.get("event") in ("run.completed", "run.failed", "run.cancelled")
            if not terminal_seen:
                self._gap(run)
        except Exception:
            self._gap(run)

    async def _work(self):
        while True:
            run = await self.queue.get()
            if run.status['status'] in TERMINAL:
                continue
            run.timer.cancel()
            self._status(run, 'starting')
            try:
                run.remote_id = await self.backend.create(run.body, run.session)
                self._save(run)
            except Exception:
                # A lost response may hide an active inference: never retry or
                # release its slot automatically. Reservation survives restart.
                self.recovery_required = True
                self._status(run, 'unknown', error='create_outcome_unknown')
                return
            collector = asyncio.create_task(self._collect(run))
            try:
                if run.stop_requested:
                    try:
                        await self.backend.stop(run.remote_id)
                    except Exception:
                        pass  # Keep observing; failed stop does not free slot.
                while True:
                    try:
                        status = await self.backend.status(run.remote_id)
                    except Exception:
                        await asyncio.sleep(self.poll_interval)
                        continue
                    remote_status = status.get('status', 'unknown')
                    if remote_status in TERMINAL:
                        # Final polling payload is authoritative for output/usage.
                        # Drain the independently owned SSE reader before closing
                        # downstream delivery; finite bound becomes explicit gap.
                        try:
                            await asyncio.wait_for(asyncio.shield(collector), 2)
                        except asyncio.TimeoutError:
                            self._gap(run)
                        self._status(run, remote_status, **{k: v for k, v in status.items() if k not in ('run_id', 'status')})
                        break
                    self._status(run, remote_status, **{k: v for k, v in status.items() if k not in ('run_id', 'status')})
                    await asyncio.sleep(self.poll_interval)
            finally:
                collector.cancel()
                await asyncio.gather(collector, return_exceptions=True)

    async def close(self):
        if self.closed:
            return
        self.closed = True
        for run in self.runs.values():
            if run.timer:
                run.timer.cancel()
        if self.worker:
            self.worker.cancel()
            await asyncio.gather(self.worker, return_exceptions=True)
        self.db.close()
        os.close(self.lock)
