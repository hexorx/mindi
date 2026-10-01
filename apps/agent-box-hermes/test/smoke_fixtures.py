"""Synthetic offline observations only; never real qualification evidence."""
import hashlib
import json
import smoke


def encoded(value):
    return json.dumps(value, sort_keys=True).encode()


def observations(name):
    if name == 'api_stream':
        def frame(i, event, data):
            return f'id: {i}\nevent: {event}\ndata: {json.dumps(data)}\n\n'
        tail = frame(2, 'run.completed', {'status': 'completed'})
        return {'initial_sse': frame(1, 'message.delta', {'text': 'hello'}) + tail,
                'replay_sse': tail, 'after': 1}
    if name == 'api_cancel':
        return dict(run_id='run-1', provider_run_id='run-1', first_token_at=1,
                    stop_at=2, terminal_at=3, provider_closed_at=3,
                    status_at_stop='running', final_status='cancelled',
                    provider_aborted=True, reservation_calls=[])
    if name == 'api_retry':
        return dict(run_id='run-1', repeated_run_id='run-1', conflict_status=409,
                    conflict_code='idempotency_conflict', retry_at=3, response_at=4,
                    drain_until=10, entry_log_started_at=0,
                    calls=[dict(request_id='request-1', run_id='run-1', entered_at=1)])
    if name in {'memory_recreation', 'second_box_recall'}:
        nonce = 'a0123456789bcdef' * 2
        return dict(nonce=nonce, distractors=['other fact', 'another fact'],
                    retained=nonce, empty_bank=[], recreated=True, recalled=[nonce],
                    recall_phase_retains=0, bank_a='a', bank_b='b', box_b_recalled=[])
    return dict(assertion=name, outcome='pass')


def fixture(manifest='sha256:' + 'a'*64, source='b'*40, observed='2026-09-30T00:00:00Z', component=False):
    attachments = {}
    def attach(path, data):
        attachments[path] = encoded(data)
        return {'path': path, 'sha256': hashlib.sha256(attachments[path]).hexdigest()}
    checks = {}
    for name, scope in smoke.SCOPES.items():
        deps = [dict(component=k, state='real', reason='Synthetic unit test identity',
                     identity=({'provider': 'synthetic-test', 'model': 'synthetic-test'} if k in smoke.PROVIDERS else
                               {'implementation': 'synthetic-test', 'version': '1'})) for k in sorted(smoke.COMPONENTS)]
        config = attach('raw-' + name + '-config.json', dict(assertion=name, dependencies=deps))
        evidence = attach('raw-' + name + '-evidence.json', dict(assertion=name, config_sha256=config['sha256'], observations=observations(name)))
        checks[name] = dict(status='pass', execution_path='native',
                            evidence_class='component_integration' if component else 'release_qualification',
                            scope=scope, image_digest_tested=manifest, inference_spend='none',
                            mocked_components=[], dependencies=deps, config=config, evidence=evidence)
    return dict(schema_version=2, kind='smoke', status='pass', source_commit=source,
                manifest_digest=manifest, observed_at=observed, raw=list(attachments), checks=checks), attachments
