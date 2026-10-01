"""Credential-holding provider proxy with a hard pre-call budget (HEX-248).

Every real-provider request from the qualification boxes goes through this proxy;
boxes only hold dummy keys. Each request is logged at entry, then admitted only
after an atomic worst-case reservation against a fixed ceiling. There is no
refill: the ceiling is part of the policy hash pinned in the ledger header, and
a restart replays the ledger, charging any unsettled reservation in full.

Local cancellation records the upstream connection closure; it does not prove
the provider stopped billing. The proxy never retries and never substitutes
responses.
"""
import argparse
import hashlib
import http.client
import json
import os
import select
import socket
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit
import uuid

MTOK = Decimal(1_000_000)
POLICY_KEYS = {'version', 'ceiling_usd', 'safety_factor', 'rates_usd_per_mtok', 'rates_source',
               'routes', 'phases', 'upstream'}
ROUTE_KEYS = {'kind', 'model', 'max_body_bytes', 'max_requests'}
KINDS = {'chat': '/chat/completions', 'embeddings': '/embeddings'}
# Chat template overhead above raw JSON bytes; one token always covers >= 1 byte.
PER_MESSAGE_TOKENS = 4
PER_TOOL_TOKENS = 8
FIXED_TOKENS = 256
CHAT_DENIED_KEYS = ('web_search_options', 'audio', 'prediction', 'logit_bias', 'functions')
UPSTREAM_TIMEOUT = 120


class Denied(Exception):
    def __init__(self, status, reason):
        super().__init__(reason)
        self.status = status
        self.reason = reason


def _decimal(value, name):
    if not isinstance(value, str):
        raise ValueError(f'policy: {name} must be a decimal string')
    number = Decimal(value)
    if not number.is_finite() or number < 0:
        raise ValueError(f'policy: {name} must be finite and non-negative')
    return number


def _positive_int(value, name):
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f'policy: {name} must be a positive integer')
    return value


class Policy:
    """Validated, immutable budget policy. Unknown rates or unbounded routes fail."""

    def __init__(self, raw):
        if not isinstance(raw, dict) or set(raw) != POLICY_KEYS or raw['version'] != 1:
            raise ValueError('policy: exact version 1 keys required')
        self.digest = hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest()
        self.ceiling = _decimal(raw['ceiling_usd'], 'ceiling_usd')
        self.safety = _decimal(raw['safety_factor'], 'safety_factor')
        if self.ceiling <= 0 or self.safety < 1:
            raise ValueError('policy: ceiling must be positive and safety_factor >= 1')
        if not isinstance(raw['rates_source'], str) or not raw['rates_source'].startswith('https://'):
            raise ValueError('policy: rates_source must cite the official rate page')
        upstream = urlsplit(raw['upstream'] if isinstance(raw['upstream'], str) else '')
        if upstream.scheme != 'https' or not upstream.hostname or upstream.query or upstream.username:
            raise ValueError('policy: upstream must be an https base URL')
        self.upstream = raw['upstream'].rstrip('/')
        self.rates = {}
        for model, rate in raw['rates_usd_per_mtok'].items():
            if not isinstance(rate, dict) or set(rate) != {'input', 'output'}:
                raise ValueError(f'policy: rate for {model} needs exactly input and output')
            self.rates[model] = (_decimal(rate['input'], model + '.input') / MTOK,
                                 _decimal(rate['output'], model + '.output') / MTOK)
        self.routes = {}
        for name, route in raw['routes'].items():
            if not isinstance(route, dict) or set(route) != ROUTE_KEYS or route['kind'] not in KINDS:
                raise ValueError(f'policy: route {name} must bound kind/model/body/requests')
            if route['model'] not in self.rates:
                raise ValueError(f'policy: route {name} model has no rate')
            _positive_int(route['max_body_bytes'], name + '.max_body_bytes')
            _positive_int(route['max_requests'], name + '.max_requests')
            self.routes[name] = dict(route)
        self.phases = {}
        for phase, caps in raw['phases'].items():
            if not isinstance(caps, dict):
                raise ValueError(f'policy: phase {phase} must map routes to output caps')
            for name, cap in caps.items():
                if name not in self.routes:
                    raise ValueError(f'policy: phase {phase} names unknown route {name}')
                kind = self.routes[name]['kind']
                if kind == 'chat':
                    _positive_int(cap, f'{phase}.{name}')
                elif cap != 0:
                    raise ValueError(f'policy: embeddings output cap must be 0 in {phase}')
            self.phases[phase] = dict(caps)
        if 'closed' not in self.phases or self.phases['closed']:
            raise ValueError('policy: a closed phase admitting nothing is required')
        worst = self.worst_case()
        if worst > self.ceiling:
            raise ValueError(f'policy: worst-case fanout {worst} exceeds ceiling {self.ceiling}')

    def max_output(self, name):
        return max((caps.get(name, 0) for caps in self.phases.values()), default=0)

    def input_bound(self, name, body_bytes, messages=0, tools=0):
        if self.routes[name]['kind'] == 'embeddings':
            return body_bytes
        return body_bytes + PER_MESSAGE_TOKENS * messages + PER_TOOL_TOKENS * tools + FIXED_TOKENS

    def cost(self, model, input_tokens, output_tokens):
        rate_in, rate_out = self.rates[model]
        return (rate_in * input_tokens + rate_out * output_tokens) * self.safety

    def worst_call(self, name):
        route = self.routes[name]
        # Admission explicitly enforces these count and rewritten-byte limits.
        size = route['max_body_bytes']
        bound = self.input_bound(name, size, size // 30, size // 40)
        return self.cost(route['model'], bound, self.max_output(name))

    def worst_case(self):
        return sum((self.worst_call(n) * r['max_requests'] for n, r in self.routes.items()), Decimal(0))

    @classmethod
    def load(cls, path):
        return cls(json.loads(Path(path).read_text()))


def prepare(policy, name, phase, body):
    """Validate one request body; return (forward_bytes, input_bound, output_cap, stream)."""
    route = policy.routes[name]
    caps = policy.phases.get(phase)
    if caps is None or name not in caps:
        raise Denied(403, f'route {name} is not admitted in phase {phase}')
    if len(body) > route['max_body_bytes']:
        raise Denied(413, 'request body exceeds route bound')
    try:
        data = json.loads(body)
    except ValueError:
        raise Denied(400, 'request body is not JSON') from None
    if not isinstance(data, dict) or data.get('model') != route['model']:
        raise Denied(403, 'model is not the approved model for this route')
    if route['kind'] == 'embeddings':
        inputs = data.get('input')
        inputs = [inputs] if isinstance(inputs, str) else inputs
        if not isinstance(inputs, list) or not inputs or not all(isinstance(i, str) for i in inputs):
            raise Denied(400, 'embeddings input must be text')
        return body, policy.input_bound(name, len(body)), 0, False
    messages = data.get('messages')
    if not isinstance(messages, list) or not messages:
        raise Denied(400, 'chat messages required')
    if len(messages) > route['max_body_bytes'] // 30:
        raise Denied(413, 'message count exceeds route bound')
    for message in messages:
        if not isinstance(message, dict) or message.get('role') not in (
                'system', 'developer', 'user', 'assistant', 'tool', 'function'):
            raise Denied(400, 'invalid chat message')
        content = message.get('content') if isinstance(message, dict) else None
        if isinstance(content, list) and any(not isinstance(p, dict) or p.get('type') != 'text' for p in content):
            raise Denied(403, 'only text content parts are bounded by request bytes')
    if any(k in data for k in CHAT_DENIED_KEYS):
        raise Denied(403, 'request uses a cost-bearing option outside the envelope')
    if data.get('n', 1) != 1 or data.get('service_tier', 'default') != 'default':
        raise Denied(403, 'n and service_tier must be default')
    if data.get('modalities', ['text']) != ['text']:
        raise Denied(403, 'text output only')
    cap = caps[name]
    requested = [data[k] for k in ('max_tokens', 'max_completion_tokens') if k in data]
    if any(not isinstance(v, int) or isinstance(v, bool) or v <= 0 for v in requested):
        raise Denied(400, 'invalid output token limit')
    data.pop('max_tokens', None)
    data['max_completion_tokens'] = min([cap] + requested)
    stream = data.get('stream') is True
    if stream:
        data['stream_options'] = {'include_usage': True}
    tools = data.get('tools', [])
    if not isinstance(tools, list) or any(not isinstance(t, dict) for t in tools):
        raise Denied(400, 'invalid tools')
    if len(tools) > route['max_body_bytes'] // 40:
        raise Denied(413, 'tool count exceeds route bound')
    forward = json.dumps(data, separators=(',', ':')).encode()
    if len(forward) > route['max_body_bytes']:
        raise Denied(413, 'rewritten body exceeds route bound')
    bound = policy.input_bound(name, max(len(body), len(forward)), len(messages), len(tools))
    return forward, bound, data['max_completion_tokens'], stream


class Ledger:
    """Append-only JSONL, flushed and fsynced before the provider sees anything."""

    def __init__(self, path, policy):
        self.path = Path(path)
        self.policy = policy
        self.lock = threading.Lock()
        self.charged = Decimal(0)
        self.open = {}
        self.counts = {name: 0 for name in policy.routes}
        self.frozen = None
        self.phase = 'closed'
        if self.path.exists() and self.path.stat().st_size:
            self._replay()
        else:
            self._write({'event': 'header', 'policy_sha256': policy.digest,
                         'ceiling_usd': str(policy.ceiling)})

    def _replay(self):
        lines = [json.loads(line) for line in self.path.read_text().splitlines() if line]
        if not lines or lines[0].get('event') != 'header' or lines[0].get('policy_sha256') != self.policy.digest:
            raise ValueError('ledger: policy changed since the ledger began; no refill allowed')
        reserved = {}
        for record in lines[1:]:
            event = record.get('event')
            if event == 'reserve':
                reserved[record['entry_id']] = Decimal(record['reserved_usd'])
                self.counts[record['route']] += 1
            elif event == 'settle':
                reserved.pop(record['entry_id'], None)
                self.charged += Decimal(record['charged_usd'])
            elif event == 'frozen':
                self.frozen = record['reason']
        # A crash mid-call may have spent the whole reservation.
        for entry_id, amount in reserved.items():
            self.charged += amount
            self._write({'event': 'settle', 'entry_id': entry_id, 'charged_usd': str(amount),
                         'basis': 'unsettled_on_restart'})

    def _write(self, record):
        record.setdefault('at', time.time())
        with self.path.open('a') as out:
            out.write(json.dumps(record, sort_keys=True) + '\n')
            out.flush()
            os.fsync(out.fileno())

    def entry(self, route, method, path, body):
        entry_id = str(uuid.uuid4())
        with self.lock:
            self._write({'event': 'entry', 'entry_id': entry_id, 'route': route, 'phase': self.phase,
                         'method': method, 'path': path, 'body_bytes': len(body),
                         'body_sha256': hashlib.sha256(body).hexdigest()})
        return entry_id

    def remaining(self):
        return self.policy.ceiling - self.charged - sum(self.open.values(), Decimal(0))

    def reserve(self, entry_id, name, body):
        """Atomically admit one call at its worst-case cost or raise Denied."""
        with self.lock:
            try:
                if self.frozen:
                    raise Denied(429, 'budget frozen: ' + self.frozen)
                route = self.policy.routes[name]
                if self.counts[name] >= route['max_requests']:
                    raise Denied(429, f'route {name} request bound exhausted')
                forward, bound, cap, stream = prepare(self.policy, name, self.phase, body)
                amount = self.policy.cost(route['model'], bound, cap)
                if amount > self.remaining():
                    raise Denied(429, 'reservation exceeds remaining ceiling; no refill')
            except Denied as denial:
                self._write({'event': 'deny', 'entry_id': entry_id, 'status': denial.status,
                             'reason': denial.reason})
                raise
            self.counts[name] += 1
            self.open[entry_id] = amount
            self._write({'event': 'reserve', 'entry_id': entry_id, 'route': name, 'phase': self.phase,
                         'input_bound': bound, 'output_cap': cap, 'stream': stream,
                         'reserved_usd': str(amount)})
            return forward, stream

    def settle(self, entry_id, name, usage, **observed):
        """Charge actual usage if reported, else the full reservation."""
        with self.lock:
            amount = self.open[entry_id]
            basis, charged = 'reservation', amount
            route = self.policy.routes[name]
            counters = ('prompt_tokens', 'completion_tokens') if route['kind'] == 'chat' else ('prompt_tokens',)
            if isinstance(usage, dict) and all(
                    type(usage.get(k)) is int and usage[k] >= 0 for k in counters):
                actual = self.policy.cost(route['model'], usage['prompt_tokens'],
                                          usage['completion_tokens'] if route['kind'] == 'chat' else 0)
                basis, charged = 'usage', actual
                if actual > amount:
                    self.frozen = 'usage exceeded reservation'
                    self._write({'event': 'frozen', 'entry_id': entry_id, 'reason': self.frozen})
            # Keep the reservation live if validation or durable append fails.
            self._write({'event': 'settle', 'entry_id': entry_id, 'charged_usd': str(charged),
                         'basis': basis, 'usage': usage, **observed})
            self.charged += charged
            del self.open[entry_id]

    def set_phase(self, phase):
        with self.lock:
            if phase not in self.policy.phases:
                raise ValueError('unknown phase')
            self.phase = phase
            self._write({'event': 'phase', 'phase': phase})

    def state(self):
        with self.lock:
            return {'phase': self.phase, 'charged_usd': str(self.charged),
                    'open_usd': str(sum(self.open.values(), Decimal(0))),
                    'remaining_usd': str(self.remaining()), 'counts': dict(self.counts),
                    'frozen': self.frozen, 'policy_sha256': self.policy.digest}


def _usage_from_sse(line, usage):
    if line.startswith(b'data:'):
        payload = line[5:].strip()
        if payload and payload != b'[DONE]':
            try:
                found = json.loads(payload).get('usage')
            except (ValueError, AttributeError):
                return usage
            if isinstance(found, dict):
                return found
    return usage


def make_handler(ledger, key, prefixes, upstream=None):
    policy = ledger.policy
    upstream = urlsplit(upstream or policy.upstream)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass

        def _reply(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def _route(self):
            for name, prefix in prefixes.items():
                if self.path == prefix + KINDS[policy.routes[name]['kind']]:
                    return name
            return None

        def do_GET(self):
            self._reply(404, {'error': {'message': 'denied: only approved POST endpoints are proxied'}})

        def do_POST(self):
            length = int(self.headers.get('Content-Length') or 0)
            limit = max(r['max_body_bytes'] for r in policy.routes.values())
            body = self.rfile.read(min(length, limit + 1))
            name = self._route()
            entry_id = ledger.entry(name, 'POST', self.path, body)
            if name is None:
                ledger._write({'event': 'deny', 'entry_id': entry_id, 'status': 404,
                               'reason': 'endpoint outside the envelope'})
                return self._reply(404, {'error': {'message': 'denied: endpoint outside the envelope'}})
            if length > limit:
                ledger._write({'event': 'deny', 'entry_id': entry_id, 'status': 413,
                               'reason': 'request body exceeds route bound'})
                return self._reply(413, {'error': {'message': 'denied: body too large'}})
            try:
                forward, stream = ledger.reserve(entry_id, name, body)
            except Denied as denial:
                return self._reply(denial.status, {'error': {'message': 'denied: ' + denial.reason,
                                                             'type': 'budget_proxy'}})
            self._forward(entry_id, name, forward, stream)

        def _forward(self, entry_id, name, forward, stream):
            cls = http.client.HTTPSConnection if upstream.scheme == 'https' else http.client.HTTPConnection
            conn = cls(upstream.hostname, upstream.port, timeout=UPSTREAM_TIMEOUT)
            usage, observed, settled = None, {'stream': stream}, []
            response = None
            monitor = None
            finished = threading.Event()
            path = upstream.path.rstrip('/') + KINDS[policy.routes[name]['kind']]

            def settle():
                if not settled:
                    observed['upstream_closed_at'] = time.time()
                    ledger.settle(entry_id, name, None if 'client_disconnected_at' in observed else usage,
                                  **observed)
                    settled.append(True)

            def watch_client(upstream_socket):
                while not finished.wait(0.02):
                    try:
                        readable, _, _ = select.select([self.connection], [], [], 0)
                        if not readable:
                            continue
                        # This endpoint accepts one request per connection. EOF,
                        # reset, or extra pipelined bytes all end that request.
                        self.connection.recv(1, socket.MSG_PEEK)
                    except OSError:
                        pass
                    observed['client_disconnected_at'] = time.time()
                    try:
                        upstream_socket.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    return

            try:
                conn.connect()
                monitor = threading.Thread(target=watch_client, args=(conn.sock,), daemon=True)
                monitor.start()
                conn.request('POST', path, forward, {'Authorization': 'Bearer ' + key,
                                                     'Content-Type': 'application/json'})
                response = conn.getresponse()
                observed.update(status=response.status,
                                provider_request_id=response.getheader('x-request-id'))
                self.send_response(response.status)
                self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
                self.send_header('Connection', 'close')
                self.close_connection = True
                if not stream or response.status != 200:
                    data = response.read()
                    conn.close()
                    if response.status == 200:
                        try:
                            found = json.loads(data).get('usage')
                        except (ValueError, AttributeError):
                            found = None
                        usage = found if isinstance(found, dict) else None
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                self.end_headers()
                while True:
                    line = response.readline()
                    if not line:
                        break
                    observed.setdefault('first_byte_at', time.time())
                    usage = _usage_from_sse(line, usage)
                    try:
                        self.wfile.write(line)
                        self.wfile.flush()
                    except OSError:
                        observed['client_disconnected_at'] = time.time()
                        break
            except (OSError, http.client.HTTPException, ValueError) as error:
                observed['error'] = type(error).__name__
            finally:
                finished.set()
                if monitor is not None:
                    monitor.join()
                if response is not None:
                    response.close()
                conn.close()
                settle()

    return Handler


def make_admin(ledger):
    class Admin(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _reply(self, status, payload):
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self._reply(200, ledger.state()) if self.path == '/state' else self._reply(404, {})

        def do_POST(self):
            if self.path != '/phase':
                return self._reply(404, {})
            try:
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length') or 0)))
                ledger.set_phase(body['phase'])
            except (ValueError, KeyError, TypeError):
                return self._reply(400, {'error': 'unknown phase'})
            self._reply(200, ledger.state())

    return Admin


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--policy', required=True)
    parser.add_argument('--ledger', required=True)
    parser.add_argument('--key-file', required=True)
    parser.add_argument('--listen', default='0.0.0.0:9900')
    parser.add_argument('--admin', default='127.0.0.1:9901')
    args = parser.parse_args(argv)
    policy = Policy.load(args.policy)
    key = Path(args.key_file).read_text().strip()
    if not key or any(c.isspace() for c in key):
        raise SystemExit('budget_proxy: invalid key file (value redacted)')
    ledger = Ledger(args.ledger, policy)
    prefixes = {name: '/' + name + '/v1' for name in policy.routes}
    host, port = args.listen.rsplit(':', 1)
    admin_host, admin_port = args.admin.rsplit(':', 1)
    if admin_host not in ('127.0.0.1', '::1'):
        raise SystemExit('budget_proxy: admin must bind loopback')
    server = ThreadingHTTPServer((host, int(port)), make_handler(ledger, key, prefixes))
    admin = ThreadingHTTPServer((admin_host, int(admin_port)), make_admin(ledger))
    threading.Thread(target=admin.serve_forever, daemon=True).start()
    server.serve_forever()


if __name__ == '__main__':
    main()
