"""HEX-241 negative controls and immutable historical-report regression."""
import ast
import copy
import hashlib
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts/hermes-release'))
import smoke
from smoke_fixtures import fixture, observations, encoded


class SmokeTests(unittest.TestCase):
    def setUp(self):
        self.report, self.raw = fixture()
        self.digest = self.report['manifest_digest']

    def validate(self):
        return smoke.validate_smoke(self.report, self.digest, self.raw)

    def rebind(self, name):
        check = self.report['checks'][name]
        ref = check['config']
        self.raw[ref['path']] = encoded(dict(assertion=name, dependencies=check['dependencies']))
        ref['sha256'] = hashlib.sha256(self.raw[ref['path']]).hexdigest()
        evidence = check['evidence']
        value = json.loads(self.raw[evidence['path']])
        value['config_sha256'] = ref['sha256']
        self.raw[evidence['path']] = encoded(value)
        evidence['sha256'] = hashlib.sha256(self.raw[evidence['path']]).hexdigest()

    def make_mock(self, name, component):
        check = self.report['checks'][name]
        dep = next(x for x in check['dependencies'] if x['component'] == component)
        self.raw['raw-fixture.py'] = b'# synthetic provider fixture\n'
        self.report['raw'].append('raw-fixture.py')
        dep.update(state='mock', identity={'fixture': {'path': 'raw-fixture.py', 'sha256': hashlib.sha256(self.raw['raw-fixture.py']).hexdigest()}})
        check['mocked_components'] = [component]
        self.rebind(name)

    def test_complete_real_and_component_boundaries(self):
        self.assertTrue(self.validate())
        self.make_mock('api_stream', 'llm')
        with self.assertRaisesRegex(ValueError, 'mock smoke'): self.validate()
        for c in self.report['checks'].values(): c['evidence_class'] = 'component_integration'
        with self.assertRaisesRegex(ValueError, 'class/scope'): self.validate()
        self.assertTrue(smoke.validate_component_smoke(self.report, self.digest, self.raw))
        self.report['checks']['api_stream']['evidence_class'] = 'release_qualification'
        with self.assertRaises(ValueError): smoke.validate_component_smoke(self.report, self.digest, self.raw)

    def test_supplied_report_rejected_by_extracted_gate_ast(self):
        path = Path(__file__).parent / 'fixtures/hex212-smoke-v1.json'
        supplied = json.loads(path.read_bytes())
        tree = ast.parse((ROOT / 'scripts/hermes-release/gate.py').read_text())
        fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == 'verify_candidate')
        call = next(n for n in fn.body if isinstance(n, ast.Expr) and isinstance(n.value, ast.Call) and getattr(n.value.func, 'id', None) == 'validate_smoke')
        # Preserve the gate call, supply existing read-only evidence paths.
        module = ast.Module(body=[call], type_ignores=[])
        class Directory:
            def __truediv__(self, _): return path
        with self.assertRaises(ValueError):
            exec(compile(module, '<gate-smoke-block>', 'exec'), dict(validate_smoke=smoke.validate_smoke,
                 smoke=supplied, record={'manifest_digest': supplied['manifest_digest']}, directory=Directory()))
        with self.assertRaises(ValueError): smoke.validate_smoke(supplied, supplied['manifest_digest'], {})

    def test_every_required_field_missing_null_or_unknown_fails(self):
        original = copy.deepcopy(self.report)
        for field in original['checks']['api_stream']:
            for mutation in ('missing', None):
                with self.subTest(field=field, mutation=mutation):
                    self.report = copy.deepcopy(original)
                    c = self.report['checks']['api_stream']
                    if mutation == 'missing': c.pop(field)
                    else: c[field] = None
                    with self.assertRaises(ValueError): self.validate()
        self.report = copy.deepcopy(original)
        self.report['checks']['api_stream']['waiver'] = 'approved'
        with self.assertRaises(ValueError): self.validate()

    def test_malformed_mock_inventory(self):
        for value in (None, '', 'llm', {}, ['unknown'], ['llm', 'llm'], [None], [[]]):
            with self.subTest(value=value):
                self.report, self.raw = fixture()
                self.report['checks']['api_stream']['mocked_components'] = value
                with self.assertRaises(ValueError): self.validate()

    def test_hidden_second_box_memory_mock_and_contradictions(self):
        self.make_mock('second_box_recall', 'memory_embeddings')
        self.report['checks']['second_box_recall']['mocked_components'] = []
        with self.assertRaisesRegex(ValueError, 'contradiction'): self.validate()
        self.report, self.raw = fixture()
        self.report['checks']['api_stream']['mocked_components'] = ['llm']
        with self.assertRaisesRegex(ValueError, 'contradiction'): self.validate()

    def test_dependency_inventory_rejections(self):
        for value in (None, 'real', [], [{}]):
            self.report, self.raw = fixture()
            self.report['checks']['api_retry']['dependencies'] = value
            with self.assertRaises(ValueError): self.validate()
        for field, value in [('state', None), ('state', 'unknown'), ('component', 'unknown'), ('identity', None), ('reason', '')]:
            self.report, self.raw = fixture()
            self.report['checks']['api_retry']['dependencies'][0][field] = value
            with self.assertRaises(ValueError): self.validate()
        self.report, self.raw = fixture()
        c = self.report['checks']['second_box_recall']
        next(d for d in c['dependencies'] if d['component'] == 'memory_embeddings')['state'] = 'not_exercised'
        self.rebind('second_box_recall')
        with self.assertRaisesRegex(ValueError, 'transitive'): self.validate()

    def test_config_evidence_and_fixture_hashes(self):
        for kind in ('config', 'evidence'):
            self.report, self.raw = fixture()
            self.raw[self.report['checks']['api_stream'][kind]['path']] += b' '
            with self.assertRaisesRegex(ValueError, 'mismatched raw'): self.validate()
        self.report, self.raw = fixture(component=True)
        self.make_mock('api_stream', 'llm')
        self.raw['raw-fixture.py'] += b'changed'
        with self.assertRaises(ValueError): smoke.validate_component_smoke(self.report, self.digest, self.raw)
        self.report, self.raw = fixture()
        self.report['checks']['api_stream']['dependencies'][0]['reason'] = 'changed config'
        with self.assertRaisesRegex(ValueError, 'config inventory'): self.validate()

    def test_evaluator_negative_controls(self):
        cases = [('api_cancel', 'provider_aborted', False), ('api_cancel', 'first_token_at', None),
                 ('api_cancel', 'status_at_stop', 'queued'), ('api_cancel', 'terminal_at', 99),
                 ('api_stream', 'replay_sse', ''), ('memory_recreation', 'recalled', []),
                 ('memory_recreation', 'recall_phase_retains', 1), ('memory_recreation', 'empty_bank', ['fact']),
                 ('api_retry', 'drain_until', 4)]
        for name, field, value in cases:
            with self.subTest(name=name, field=field):
                trace = observations(name); trace[field] = value
                with self.assertRaises(ValueError): smoke.evaluate(name, trace)
        trace = observations('api_retry')
        # Duplicate entered after retry starts and finishes BEFORE retry response.
        trace['calls'].append(dict(request_id='fast-duplicate', run_id='run-1', entered_at=3.1))
        with self.assertRaisesRegex(ValueError, 'additional provider'): smoke.evaluate('api_retry', trace)

    def test_replay_parser(self):
        trace = observations('api_stream')
        trace['initial_sse'] = ': keepalive\r\n\r\n' + trace['initial_sse'].replace('\n', '\r\n')
        smoke.evaluate('api_stream', trace)
        for body in ('', '2a\r\nid: 1\r\n', trace['replay_sse'] * 2,
                     trace['replay_sse'].rstrip(), trace['replay_sse'].replace('run.completed', 'message.delta')):
            invalid = observations('api_stream'); invalid['replay_sse'] = body
            with self.assertRaises(ValueError): smoke.evaluate('api_stream', invalid)
        multiline = 'id: 1\nevent: message.delta\ndata: {"text":\ndata: "hello"}\n\n'
        self.assertEqual(smoke.parse_sse(multiline)[0]['data'], {'text': 'hello'})

    def test_bound_evaluator_cannot_be_bypassed_with_pass_status(self):
        c = self.report['checks']['api_cancel']
        value = json.loads(self.raw[c['evidence']['path']])
        value['observations']['provider_aborted'] = False
        self.raw[c['evidence']['path']] = encoded(value)
        c['evidence']['sha256'] = hashlib.sha256(self.raw[c['evidence']['path']]).hexdigest()
        with self.assertRaises(ValueError): self.validate()

    def test_unknown_enums_and_legacy_real_plus_mock(self):
        for field, value in [('execution_path', 'unknown'), ('execution_path', 'fixture'),
                             ('evidence_class', 'unknown'), ('scope', 'unknown'),
                             ('status', 'skipped'), ('inference_spend', None),
                             ('config', {'path': [], 'sha256': 'a'*64})]:
            self.report, self.raw = fixture()
            self.report['checks']['api_stream'][field] = value
            with self.assertRaises(ValueError): self.validate()
        self.report, self.raw = fixture()
        self.make_mock('api_stream', 'llm')
        self.report['checks']['api_stream']['mode'] = 'real'
        with self.assertRaises(ValueError): self.validate()

    def test_unexercised_fixture_is_disclosed_and_hashed(self):
        self.make_mock('desktop_auth', 'memory_embeddings')
        c = self.report['checks']['desktop_auth']
        next(d for d in c['dependencies'] if d['component'] == 'memory_embeddings')['state'] = 'not_exercised'
        c['mocked_components'] = []
        self.rebind('desktop_auth')
        self.assertTrue(self.validate())
