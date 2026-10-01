"""Offline enforcement tests for the HEX-248 budget proxy; a fake upstream only."""
import copy
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import json
from pathlib import Path
import socket
import select
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts/hermes-release'))
import budget_proxy as bp

SHIPPED = json.loads((ROOT / 'scripts/hermes-release/real-provider-policy.json').read_text())


def chat(model='gpt-4o-mini', **extra):
    return json.dumps({'model': model, 'messages': [{'role': 'user', 'content': 'hi'}], **extra}).encode()


class FakeUpstream:
    """Records request entry and returns canned usage; never a real provider."""

    def __init__(self, ledger_path=None, status=200, usage=None, stream_chunks=0, chunk_delay=0.0, stall=None):
        self.requests = []
        self.ledger_at_entry = []
        self.closed = threading.Event()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *args):
                pass

            def wait_for_close(self):
                readable, _, _ = select.select([self.connection], [], [], 3)
                if readable and not self.connection.recv(1):
                    fake.closed.set()
                self.close_connection = True

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                fake.requests.append({'path': self.path, 'body': body,
                                      'auth': self.headers.get('Authorization')})
                if ledger_path:
                    fake.ledger_at_entry.append(Path(ledger_path).read_text())
                if stall == 'headers':
                    self.wait_for_close()
                    return
                if status != 200:
                    data = b'{"error":{"message":"rate limited"}}'
                    self.send_response(status)
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                if body.get('stream'):
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.send_header('x-request-id', 'req_fake_stream')
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    try:
                        for i in range(stream_chunks):
                            self.wfile.write(b'data: {"choices":[{"delta":{"content":"t%d"}}]}\n\n' % i)
                            self.wfile.flush()
                            if stall == 'stream':
                                self.wait_for_close()
                                return
                            time.sleep(chunk_delay)
                        if usage is not None:
                            self.wfile.write(b'data: ' + json.dumps({'choices': [], 'usage': usage}).encode() + b'\n\n')
                        self.wfile.write(b'data: [DONE]\n\n')
                        self.wfile.flush()
                    except OSError:
                        pass
                    fake.closed.set()
                    self.close_connection = True
                    return
                data = json.dumps({'usage': usage} if usage is not None else {}).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('x-request-id', 'req_fake_1')
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                if stall == 'body':
                    self.wait_for_close()
                    return
                self.wfile.write(data)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/v1'

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class Harness:
    def __init__(self, policy, ledger_path, upstream):
        self.ledger = bp.Ledger(ledger_path, policy)
        prefixes = {name: '/' + name + '/v1' for name in policy.routes}
        self.server = ThreadingHTTPServer(('127.0.0.1', 0),
                                          bp.make_handler(self.ledger, 'sk-test-not-real', prefixes, upstream.url))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.port = self.server.server_port

    def post(self, path, body):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        conn.request('POST', path, body, {'Content-Type': 'application/json', 'Authorization': 'Bearer dummy'})
        response = conn.getresponse()
        data = response.read()
        conn.close()
        deadline = time.monotonic() + 2
        while self.ledger.state()['open_usd'] != '0' and time.monotonic() < deadline:
            time.sleep(0.01)
        return response.status, data

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


def records(path, event=None):
    rows = [json.loads(line) for line in Path(path).read_text().splitlines()]
    return [r for r in rows if event is None or r['event'] == event]


class PolicyTest(unittest.TestCase):
    def test_shipped_policy_worst_case_fits_proposed_ceiling(self):
        policy = bp.Policy(SHIPPED)
        self.assertEqual(policy.ceiling, Decimal('1.00'))
        self.assertLessEqual(policy.worst_case(), policy.ceiling)
        self.assertEqual(policy.max_output('hermes'), 256)
        self.assertEqual(policy.phases['api_complete']['hermes'], 128)
        self.assertEqual(policy.phases['api_cancel']['hermes'], 256)
        self.assertEqual(policy.phases['reservation_stop'], {})

    def test_unbounded_or_unknown_configurations_fail_closed(self):
        cases = []
        raw = copy.deepcopy(SHIPPED); del raw['rates_usd_per_mtok']['gpt-4o-mini']; cases.append(raw)
        raw = copy.deepcopy(SHIPPED); del raw['routes']['hermes']['max_requests']; cases.append(raw)
        raw = copy.deepcopy(SHIPPED); raw['routes']['hermes']['max_requests'] = 1000; cases.append(raw)
        raw = copy.deepcopy(SHIPPED); raw['ceiling_usd'] = 1.0; cases.append(raw)
        raw = copy.deepcopy(SHIPPED); raw['safety_factor'] = '0.5'; cases.append(raw)
        raw = copy.deepcopy(SHIPPED); raw['phases']['closed'] = {'hermes': 1}; cases.append(raw)
        raw = copy.deepcopy(SHIPPED); raw['phases']['memory']['memory_embeddings'] = 5; cases.append(raw)
        raw = copy.deepcopy(SHIPPED); raw['upstream'] = 'http://api.openai.com/v1'; cases.append(raw)
        raw = copy.deepcopy(SHIPPED); raw['refill'] = True; cases.append(raw)
        for raw in cases:
            with self.assertRaises(ValueError):
                bp.Policy(raw)

    def test_request_shapes_outside_envelope_are_denied(self):
        policy = bp.Policy(SHIPPED)
        denied = [
            chat(model='gpt-6-luna'), chat(n=2), chat(service_tier='priority'),
            chat(web_search_options={}), chat(modalities=['text', 'audio']), chat(max_tokens=0),
            json.dumps({'model': 'gpt-4o-mini', 'messages': [{'role': 'user', 'content': [
                {'type': 'image_url', 'image_url': {'url': 'https://example.invalid/x.png'}}]}]}).encode(),
            b'not json', b'x' * 163841,
        ]
        for body in denied:
            with self.assertRaises(bp.Denied):
                bp.prepare(policy, 'hermes', 'api_complete', body)
        with self.assertRaises(bp.Denied):
            bp.prepare(policy, 'hermes', 'memory', chat())
        with self.assertRaises(bp.Denied):
            bp.prepare(policy, 'memory_llm', 'reservation_stop', chat())
        with self.assertRaises(bp.Denied):
            bp.prepare(policy, 'memory_embeddings', 'memory',
                       json.dumps({'model': 'text-embedding-3-small', 'input': [1, 2]}).encode())

    def test_output_caps_are_enforced_per_phase(self):
        policy = bp.Policy(SHIPPED)
        for phase, cap in (('api_complete', 128), ('api_cancel', 256)):
            for extra in ({}, {'max_tokens': 4096}, {'max_completion_tokens': 9999}):
                forward, _, out, _ = bp.prepare(policy, 'hermes', phase, chat(**extra))
                sent = json.loads(forward)
                self.assertEqual(out, cap)
                self.assertEqual(sent['max_completion_tokens'], cap)
                self.assertNotIn('max_tokens', sent)
        forward, _, out, stream = bp.prepare(policy, 'hermes', 'api_complete', chat(max_tokens=16, stream=True))
        self.assertEqual((out, stream), (16, True))
        self.assertEqual(json.loads(forward)['stream_options'], {'include_usage': True})

    def test_admitted_requests_fit_load_time_bound(self):
        policy = bp.Policy(SHIPPED)
        for name, phase in (('hermes', 'api_cancel'), ('memory_llm', 'memory')):
            size = policy.routes[name]['max_body_bytes']
            candidates = [
                chat(messages=[{}] * 50000),
                chat(messages=[{'role': 'user', 'content': ''}] * (size // 30 + 1)),
                chat(tools=[{}] * (size // 40 + 1)),
                chat(tools=[{}] * (size // 40)),
                chat(messages=[{'role': 'user', 'content': ''}] * (size // 40)),
                chat(pad='x' * (size - len(chat(pad='')))),
                chat(stream=True, pad='x' * (size - 200)),
                chat(messages=[{'role': 'user', 'content': 'é' * 1000}]),
            ]
            accepted = 0
            for body in candidates:
                try:
                    forward, bound, cap, _ = bp.prepare(policy, name, phase, body)
                except bp.Denied:
                    continue
                accepted += 1
                self.assertLessEqual(len(forward), size)
                self.assertLessEqual(policy.cost(policy.routes[name]['model'], bound, cap),
                                     policy.worst_call(name))
            self.assertGreaterEqual(accepted, 3)
            for body in candidates[:3]:
                with self.assertRaises(bp.Denied):
                    bp.prepare(policy, name, phase, body)
            with self.assertRaises(bp.Denied):
                bp.prepare(policy, name, phase, candidates[5])


class ProxyTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.ledger_path = Path(self.tmp.name) / 'ledger.jsonl'
        self.servers = []

    def tearDown(self):
        for server in self.servers:
            server.stop()
        self.tmp.cleanup()

    def start(self, raw=None, **upstream):
        fake = FakeUpstream(ledger_path=self.ledger_path, **upstream)
        proxy = Harness(bp.Policy(raw or SHIPPED), self.ledger_path, fake)
        self.servers += [proxy, fake]
        return proxy, fake

    def test_entry_is_durable_before_provider_sees_request(self):
        proxy, fake = self.start(usage={'prompt_tokens': 10, 'completion_tokens': 5})
        proxy.ledger.set_phase('api_complete')
        status, _ = proxy.post('/hermes/v1/chat/completions', chat())
        self.assertEqual(status, 200)
        self.assertEqual(len(fake.requests), 1)
        self.assertEqual(fake.requests[0]['auth'], 'Bearer sk-test-not-real')
        at_entry = [json.loads(l)['event'] for l in fake.ledger_at_entry[0].splitlines()]
        self.assertEqual(at_entry[-2:], ['entry', 'reserve'])
        settle = records(self.ledger_path, 'settle')[-1]
        self.assertEqual(settle['basis'], 'usage')
        self.assertEqual(settle['provider_request_id'], 'req_fake_1')
        self.assertEqual(Decimal(settle['charged_usd']), bp.Policy(SHIPPED).cost('gpt-4o-mini', 10, 5))

    def test_closed_and_reservation_stop_phases_invoke_no_provider(self):
        proxy, fake = self.start()
        for phase in ('closed', 'reservation_stop'):
            proxy.ledger.set_phase(phase)
            for path, body in (('/hermes/v1/chat/completions', chat()),
                               ('/memory_llm/v1/chat/completions', chat()),
                               ('/memory_embeddings/v1/embeddings',
                                json.dumps({'model': 'text-embedding-3-small', 'input': 'x'}).encode())):
                status, _ = proxy.post(path, body)
                self.assertEqual(status, 403)
        self.assertEqual(fake.requests, [])
        self.assertEqual(records(self.ledger_path, 'reserve'), [])
        self.assertEqual(len(records(self.ledger_path, 'entry')), 6)

    def test_unknown_endpoint_is_denied_and_logged(self):
        proxy, fake = self.start()
        proxy.ledger.set_phase('api_complete')
        status, _ = proxy.post('/hermes/v1/responses', chat())
        self.assertEqual(status, 404)
        self.assertEqual(fake.requests, [])
        self.assertEqual(records(self.ledger_path, 'deny')[-1]['status'], 404)

    def test_request_bound_and_ceiling_stop_without_refill(self):
        raw = copy.deepcopy(SHIPPED)
        raw['routes']['hermes']['max_requests'] = 2
        proxy, fake = self.start(raw=raw)
        proxy.ledger.set_phase('api_complete')
        results = [proxy.post('/hermes/v1/chat/completions', chat())[0] for _ in range(3)]
        self.assertEqual(results, [200, 200, 429])
        self.assertEqual(len(fake.requests), 2)
        # No usage reported: each call is charged its full reservation.
        self.assertEqual({r['basis'] for r in records(self.ledger_path, 'settle')}, {'reservation'})

    def test_reservation_larger_than_remaining_is_denied(self):
        proxy, fake = self.start()
        proxy.ledger.charged = Decimal('0.999999')
        proxy.ledger.set_phase('memory')
        body = json.dumps({'model': 'text-embedding-3-small', 'input': 'y' * 1000}).encode()
        status, data = proxy.post('/memory_embeddings/v1/embeddings', body)
        self.assertEqual(status, 429)
        self.assertIn(b'no refill', data)
        self.assertEqual(fake.requests, [])

    def test_parallel_requests_never_exceed_ceiling(self):
        # Defense in depth behind the load-time envelope check: spend already near the cap.
        proxy, fake = self.start()
        proxy.ledger.charged = Decimal('0.70')
        proxy.ledger.set_phase('api_complete')
        body = chat(pad='p' * 150000)
        threads = [threading.Thread(target=proxy.post, args=('/hermes/v1/chat/completions', body))
                   for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        charged = sum(Decimal(r['charged_usd']) for r in records(self.ledger_path, 'settle'))
        self.assertLessEqual(Decimal('0.70') + charged, Decimal('1.00'))
        self.assertLess(len(fake.requests), 8)

    def test_upstream_error_is_not_retried_and_charged_in_full(self):
        proxy, fake = self.start(status=429)
        proxy.ledger.set_phase('api_complete')
        status, _ = proxy.post('/hermes/v1/chat/completions', chat())
        self.assertEqual(status, 429)
        self.assertEqual(len(fake.requests), 1)
        settle = records(self.ledger_path, 'settle')[-1]
        self.assertEqual((settle['basis'], settle['status']), ('reservation', 429))

    def test_usage_above_reservation_freezes_budget(self):
        proxy, fake = self.start(usage={'prompt_tokens': 10_000_000, 'completion_tokens': 0})
        proxy.ledger.set_phase('api_complete')
        self.assertEqual(proxy.post('/hermes/v1/chat/completions', chat())[0], 200)
        self.assertEqual(proxy.post('/hermes/v1/chat/completions', chat())[0], 429)
        self.assertEqual(len(fake.requests), 1)
        self.assertTrue(records(self.ledger_path, 'frozen'))

    def test_stream_usage_is_reconciled(self):
        proxy, fake = self.start(usage={'prompt_tokens': 20, 'completion_tokens': 3}, stream_chunks=3)
        proxy.ledger.set_phase('api_complete')
        status, data = proxy.post('/hermes/v1/chat/completions', chat(stream=True))
        self.assertEqual(status, 200)
        self.assertIn(b'[DONE]', data)
        self.assertEqual(fake.requests[0]['body']['stream_options'], {'include_usage': True})
        settle = records(self.ledger_path, 'settle')[-1]
        self.assertEqual((settle['basis'], settle['provider_request_id']), ('usage', 'req_fake_stream'))
        self.assertIn('first_byte_at', settle)

    def test_client_disconnect_closes_upstream_and_charges_reservation(self):
        proxy, fake = self.start(usage={'prompt_tokens': 1, 'completion_tokens': 1},
                                 stream_chunks=200, chunk_delay=0.02)
        proxy.ledger.set_phase('api_cancel')
        sock = socket.create_connection(('127.0.0.1', proxy.port), timeout=5)
        body = chat(stream=True)
        sock.sendall(b'POST /hermes/v1/chat/completions HTTP/1.1\r\nHost: x\r\n'
                     b'Content-Type: application/json\r\nContent-Length: %d\r\n\r\n' % len(body) + body)
        received = b''
        while b'"t0"' not in received:
            received += sock.recv(4096)
        sock.close()
        self.assertTrue(fake.closed.wait(5))
        deadline = time.time() + 5
        while not records(self.ledger_path, 'settle') and time.time() < deadline:
            time.sleep(0.05)
        settle = records(self.ledger_path, 'settle')[-1]
        self.assertEqual(settle['basis'], 'reservation')
        self.assertIn('client_disconnected_at', settle)
        self.assertLess(settle['upstream_closed_at'] - settle['client_disconnected_at'], 5)
        self.assertEqual(fake.requests[0]['body']['max_completion_tokens'], 256)

    def test_malformed_usage_is_charged_in_full_json_and_sse(self):
        invalid = [{}, {'prompt_tokens': -1, 'completion_tokens': 0},
                   {'prompt_tokens': '1', 'completion_tokens': 0},
                   {'prompt_tokens': True, 'completion_tokens': 0},
                   {'prompt_tokens': 1}, {'completion_tokens': 1},
                   {'prompt_tokens': 1, 'completion_tokens': -1},
                   {'prompt_tokens': 1, 'completion_tokens': False},
                   {'prompt_tokens': 1.5, 'completion_tokens': 0}]
        for stream in (False, True):
            for usage in invalid:
                with self.subTest(stream=stream, usage=usage):
                    self.ledger_path = Path(self.tmp.name) / f'ledger-{stream}-{invalid.index(usage)}.jsonl'
                    proxy, fake = self.start(usage=usage)
                    proxy.ledger.set_phase('api_complete')
                    status, _ = proxy.post('/hermes/v1/chat/completions', chat(stream=stream))
                    self.assertEqual(status, 200)
                    # Response EOF can arrive just before the final fsync.
                    deadline = time.monotonic() + 1
                    while proxy.ledger.state()['open_usd'] != '0' and time.monotonic() < deadline:
                        time.sleep(0.01)
                    reserve = records(self.ledger_path, 'reserve')[-1]
                    settle = records(self.ledger_path, 'settle')[-1]
                    self.assertEqual(settle['basis'], 'reservation')
                    self.assertEqual(settle['charged_usd'], reserve['reserved_usd'])
                    restarted = bp.Ledger(self.ledger_path, proxy.ledger.policy)
                    self.assertEqual(restarted.charged, proxy.ledger.charged)

    def test_settlement_write_failure_preserves_reservation(self):
        policy = bp.Policy(SHIPPED)
        ledger = bp.Ledger(self.ledger_path, policy)
        ledger.set_phase('api_complete')
        ledger.reserve('test', 'hermes', chat())
        reserved = ledger.open['test']
        with patch.object(ledger, '_write', side_effect=OSError('disk failure')):
            with self.assertRaises(OSError):
                ledger.settle('test', 'hermes', {'prompt_tokens': 1, 'completion_tokens': 1})
        self.assertEqual(ledger.open['test'], reserved)
        self.assertEqual(ledger.charged, 0)
        self.assertEqual(bp.Ledger(self.ledger_path, policy).charged, reserved)

    def test_embedding_usage_requires_prompt_counter_only(self):
        policy = bp.Policy(SHIPPED)
        ledger = bp.Ledger(self.ledger_path, policy)
        ledger.set_phase('memory')
        body = json.dumps({'model': 'text-embedding-3-small', 'input': 'hi'}).encode()
        ledger.reserve('test', 'memory_embeddings', body)
        ledger.settle('test', 'memory_embeddings', {'prompt_tokens': 1, 'total_tokens': 1})
        self.assertEqual(ledger.charged, policy.cost('text-embedding-3-small', 1, 0))

    def test_disconnect_interrupts_blocked_upstream_reads(self):
        for stall in ('headers', 'stream', 'body'):
            with self.subTest(stall=stall):
                proxy, fake = self.start(stall=stall, stream_chunks=1)
                proxy.ledger.set_phase('api_cancel')
                sock = socket.create_connection(('127.0.0.1', proxy.port), timeout=2)
                body = chat(stream=stall != 'body')
                sock.sendall(b'POST /hermes/v1/chat/completions HTTP/1.1\r\nHost: x\r\n'
                             b'Content-Length: %d\r\n\r\n' % len(body) + body)
                deadline = time.monotonic() + 1
                while not fake.requests and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(fake.requests)
                if stall == 'stream':
                    received = b''
                    while b'"t0"' not in received:
                        received += sock.recv(4096)
                before = len(records(self.ledger_path, 'settle'))
                sock.close()
                self.assertTrue(fake.closed.wait(1), 'upstream socket was not closed promptly')
                deadline = time.monotonic() + 1
                while len(records(self.ledger_path, 'settle')) == before and time.monotonic() < deadline:
                    time.sleep(0.01)
                settle = records(self.ledger_path, 'settle')[-1]
                self.assertEqual(settle['basis'], 'reservation')
                self.assertIn('client_disconnected_at', settle)
                self.assertLess(settle['upstream_closed_at'] - settle['client_disconnected_at'], 1)

    def test_restart_replays_spend_and_rejects_policy_change(self):
        policy = bp.Policy(SHIPPED)
        ledger = bp.Ledger(self.ledger_path, policy)
        ledger.set_phase('api_complete')
        entry = ledger.entry('hermes', 'POST', '/hermes/v1/chat/completions', chat())
        ledger.reserve(entry, 'hermes', chat())
        reserved = ledger.open[entry]
        # Simulated crash before settlement.
        restarted = bp.Ledger(self.ledger_path, policy)
        self.assertEqual(restarted.charged, reserved)
        self.assertEqual(restarted.counts['hermes'], 1)
        self.assertEqual(restarted.phase, 'closed')
        raised = copy.deepcopy(SHIPPED)
        raised['ceiling_usd'] = '0.99'
        with self.assertRaises(ValueError):
            bp.Ledger(self.ledger_path, bp.Policy(raised))


if __name__ == '__main__':
    unittest.main()
