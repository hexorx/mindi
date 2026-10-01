"""Pure schema-v2 smoke qualification. No I/O, waivers, or legacy promotion."""
import datetime as dt
import hashlib
import json
import re

SCHEMA_VERSION = 2
COMPONENTS = {'native_gateway', 'compatibility', 'desktop', 'hindsight', 'pg0',
              'llm', 'memory_extraction', 'memory_embeddings'}
PROVIDERS = {'llm', 'memory_extraction', 'memory_embeddings'}
MEMORY = {'hindsight', 'pg0', 'memory_extraction', 'memory_embeddings'}
SCOPES = {
    'no_github_no_tailscale_boot': 'local_boot', 'desktop_auth': 'local_auth',
    'screenshot': 'local_desktop', 'click': 'local_desktop', 'type': 'local_desktop',
    'memory_recreation': 'hindsight_persistence',
    'second_box_credentials': 'credential_tls_volume_isolation',
    'second_box_recall': 'provider_backed_recall_isolation',
    'api_stream': 'native_stream_replay', 'api_cancel': 'native_local_cancellation',
    'api_retry': 'client_idempotency', 'shutdown': 'local_shutdown',
    'secret_redaction': 'local_redaction',
}
SMOKES = set(SCOPES)


def require(ok, message):
    if not ok:
        raise ValueError(message)


def text(value):
    return isinstance(value, str) and bool(value.strip())


def matches(pattern, value):
    return isinstance(value, str) and re.fullmatch(pattern, value) is not None


def fields(value, expected):
    require(type(value) is dict and set(value) == set(expected.split()),
            'missing/unknown object fields: ' + expected)


def strings(value):
    require(type(value) is list and all(text(x) for x in value) and
            len(value) == len(set(value)), 'explicit unique string array required')
    return set(value)


def document(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'duplicate JSON key')
            result[key] = value
        return result
    try:
        return json.loads(data, object_pairs_hook=unique,
                          parse_constant=lambda _: require(False, 'nonfinite JSON'))
    except (TypeError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError('invalid raw JSON') from exc


def bound(ref, attachments):
    fields(ref, 'path sha256')
    require(matches(r'raw-[a-z0-9][a-z0-9_.-]{0,120}', ref['path']), 'unsafe raw path')
    require(matches(r'[0-9a-f]{64}', ref['sha256']), 'invalid raw digest')
    data = attachments.get(ref['path'])
    require(type(data) is bytes and hashlib.sha256(data).hexdigest() == ref['sha256'],
            'missing or mismatched raw bytes')
    return data


def inventory(value):
    require(type(value) is list and len(value) == len(COMPONENTS), 'complete inventory required')
    result = {}
    for dep in value:
        fields(dep, 'component state identity reason')
        name, state = dep['component'], dep['state']
        require(text(name) and name in COMPONENTS and name not in result, 'unknown/duplicate component')
        require(text(state) and state in {'real', 'mock', 'not_exercised'}, 'unknown dependency state')
        require(text(dep['reason']), 'dependency reason required')
        identity = dep['identity']
        if state == 'mock' or (state == 'not_exercised' and type(identity) is dict and set(identity) == {'fixture'}):
            fields(identity, 'fixture')
        elif name in PROVIDERS:
            fields(identity, 'provider model')
            require(text(identity['provider']) and text(identity['model']), 'provider/model required')
        else:
            fields(identity, 'implementation version')
            require(text(identity['implementation']) and text(identity['version']), 'implementation identity required')
        result[name] = dep
    return result


def parse_sse(body):
    """Parse decoded HTTP entity bytes, never response.fp (chunk framing)."""
    require(type(body) is str, 'decoded SSE text required')
    frames, frame, data = [], {}, []
    for line in body.removeprefix('\ufeff').replace('\r\n', '\n').replace('\r', '\n').split('\n'):
        if not line:
            if data:
                require(set(frame) == {'id', 'event'}, 'SSE id/event required')
                require(matches(r'[1-9][0-9]*', frame['id']), 'invalid SSE id')
                frames.append({**frame, 'id': int(frame['id']), 'data': document('\n'.join(data))})
            frame, data = {}, []
        elif not line.startswith(':'):
            key, _, value = line.partition(':')
            value = value[1:] if value.startswith(' ') else value
            if key == 'data':
                data.append(value)
            elif key in {'id', 'event'}:
                require(key not in frame and '\x00' not in value, 'duplicate/malformed SSE field')
                frame[key] = value
            elif key == 'retry':
                require(value.isdecimal(), 'invalid SSE retry')
            else:
                require(False, 'unknown SSE field (possibly HTTP chunk framing)')
    require(not data and not frame, 'unterminated SSE frame')
    require(frames and all(a['id'] < b['id'] for a, b in zip(frames, frames[1:])),
            'empty/duplicate/unordered SSE')
    return frames


def number(value):
    return type(value) in {int, float} and 0 <= value < 1e15


def evaluate(name, trace):
    """Evaluate bound observations; producer booleans cannot replace these checks."""
    require(type(trace) is dict, 'observation object required')
    if name == 'api_stream':
        fields(trace, 'initial_sse replay_sse after')
        initial, replay = parse_sse(trace['initial_sse']), parse_sse(trace['replay_sse'])
        require(type(trace['after']) is int and trace['after'] in [f['id'] for f in initial], 'unknown replay cursor')
        require(replay == [f for f in initial if f['id'] > trace['after']], 'replay mismatch')
        require(initial[-1]['event'] == replay[-1]['event'] == 'run.completed', 'terminal replay required')
        for frame in initial:
            payload = frame['data']
            require(type(payload) is dict, 'native SSE payload object required')
            require('event' not in payload or payload['event'] == frame['event'],
                    'SSE event metadata mismatch')
            if frame['event'] == 'message.delta':
                require(type(payload.get('delta')) is str and len(payload['delta']) > 0,
                        'nonempty native delta required')
        require(any(f['event'] == 'message.delta' for f in initial), 'first token required')
    elif name == 'api_cancel':
        fields(trace, 'run_id provider_run_id first_token_at stop_at terminal_at provider_closed_at status_at_stop final_status provider_aborted reservation_calls')
        require(text(trace['run_id']) and trace['run_id'] == trace['provider_run_id'], 'uncorrelated cancel')
        times = [trace[k] for k in ('first_token_at', 'stop_at', 'terminal_at', 'provider_closed_at')]
        require(all(number(t) for t in times), 'cancel timestamps required')
        token, stop, terminal, closed = times
        require(token <= stop <= terminal <= stop + 5 and stop <= closed <= stop + 5,
                'cancel outside five-second bound')
        require(trace['status_at_stop'] == 'running' and trace['final_status'] == 'cancelled'
                and trace['provider_aborted'] is True, 'running/token/provider abort required')
        require(type(trace['reservation_calls']) is list and trace['reservation_calls'] == [], 'reservation invoked provider')
    elif name == 'api_retry':
        fields(trace, 'run_id repeated_run_id conflict_status conflict_code retry_at response_at drain_until entry_log_started_at calls')
        require(text(trace['run_id']) and trace['repeated_run_id'] == trace['run_id'], 'retry changed run')
        require(type(trace['conflict_status']) is int and trace['conflict_status'] == 409 and trace['conflict_code'] == 'idempotency_conflict', 'changed body must conflict')
        require(all(number(trace[k]) for k in ('retry_at', 'response_at', 'drain_until', 'entry_log_started_at')), 'retry timestamps required')
        require(trace['entry_log_started_at'] < trace['retry_at'] <= trace['response_at']
                and 5 <= trace['drain_until'] - trace['response_at'] <= 30, 'bounded retry drain required')
        require(type(trace['calls']) is list and trace['calls'], 'request-entry log required')
        ids = set()
        for call in trace['calls']:
            fields(call, 'request_id run_id entered_at')
            require(text(call['request_id']) and call['request_id'] not in ids and call['run_id'] == trace['run_id'], 'uncorrelated/duplicate request entry')
            ids.add(call['request_id'])
            require(number(call['entered_at']) and trace['entry_log_started_at'] <= call['entered_at'] < trace['retry_at'], 'additional provider request at retry')
    elif name in {'memory_recreation', 'second_box_recall'}:
        fields(trace, 'nonce distractors retained empty_bank recreated recalled recall_phase_retains bank_a bank_b box_b_recalled')
        require(matches(r'[0-9a-f]{32,}', trace['nonce']), 'unpredictable nonce required')
        distractors = strings(trace['distractors'])
        require(len(distractors) >= 2 and trace['nonce'] not in distractors, 'distinct distractors required')
        require(trace['retained'] == trace['nonce'] and trace['empty_bank'] == [], 'retain/empty bank control failed')
        require(trace['recreated'] is True and trace['nonce'] in strings(trace['recalled']), 'persisted nonce lost')
        require(type(trace['recall_phase_retains']) is int and trace['recall_phase_retains'] == 0, 'recall reseeded memory')
        require(text(trace['bank_a']) and text(trace['bank_b']) and trace['bank_a'] != trace['bank_b'], 'independent banks required')
        require(trace['nonce'] not in strings(trace['box_b_recalled']), 'cross-box nonce leak')
    else:
        fields(trace, 'assertion outcome')
        require(trace == {'assertion': name, 'outcome': 'pass'}, 'local assertion failed')


def _validate(report, manifest_digest, attachments, evidence_class):
    require(type(attachments) is dict and all(text(k) and type(v) is bytes for k, v in attachments.items()), 'raw byte mapping required')
    fields(report, 'schema_version kind status source_commit manifest_digest observed_at raw checks')
    require(type(report['schema_version']) is int and report['schema_version'] == SCHEMA_VERSION,
            'smoke schema 2 required; legacy reports cannot qualify')
    require(report['kind'] == 'smoke' and report['status'] == 'pass', 'failed smoke')
    require(matches(r'[0-9a-f]{40}', report['source_commit']) and matches(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z', report['observed_at']), 'smoke subject/time required')
    dt.datetime.fromisoformat(report['observed_at'].replace('Z', '+00:00'))
    require(matches(r'sha256:[0-9a-f]{64}', manifest_digest) and report['manifest_digest'] == manifest_digest, 'smoke digest mismatch')
    raw = strings(report['raw'])
    require(raw and raw <= set(attachments), 'raw evidence missing')
    require(type(report['checks']) is dict and set(report['checks']) == SMOKES, 'missing smoke gates')
    for name, check in report['checks'].items():
        fields(check, 'status execution_path evidence_class scope image_digest_tested inference_spend mocked_components dependencies config evidence')
        require(check['status'] == 'pass' and check['execution_path'] == 'native', 'native passed execution required')
        require(check['evidence_class'] == evidence_class and check['scope'] == SCOPES[name], 'wrong evidence class/scope')
        require(check['image_digest_tested'] == manifest_digest, 'assertion digest mismatch')
        require(check['inference_spend'] == 'none' or matches(r'https://paperclip\.mindi\.stayho\.me/HEX/approvals/[a-z0-9-]+', check['inference_spend']), 'spend authorization reference required')
        deps = inventory(check['dependencies'])
        mocks = {k for k, v in deps.items() if v['state'] == 'mock'}
        require(strings(check['mocked_components']) == mocks, 'mock inventory contradiction')
        require(evidence_class != 'release_qualification' or not mocks, 'mock smoke cannot qualify release')
        needed = (MEMORY if name in {'memory_recreation', 'second_box_recall'} else
                  {'native_gateway', 'compatibility', 'llm'} if name.startswith('api_') else
                  {'desktop'} if name in {'desktop_auth', 'screenshot', 'click', 'type'} else set())
        require(all(deps[k]['state'] != 'not_exercised' for k in needed), 'required transitive dependency not exercised')
        for dep in deps.values():
            if 'fixture' in dep['identity']:
                bound(dep['identity']['fixture'], attachments)
                require(dep['identity']['fixture']['path'] in raw, 'fixture absent from report raw')
        for ref in (check['config'], check['evidence']):
            require(type(ref) is dict and text(ref.get('path')) and ref['path'] in raw, 'assertion binding absent from report raw')
        config = document(bound(check['config'], attachments))
        fields(config, 'assertion dependencies')
        require(config == {'assertion': name, 'dependencies': check['dependencies']}, 'config inventory contradiction')
        evidence = document(bound(check['evidence'], attachments))
        fields(evidence, 'assertion config_sha256 observations')
        require(evidence['assertion'] == name and evidence['config_sha256'] == check['config']['sha256'], 'raw evidence/config binding mismatch')
        evaluate(name, evidence['observations'])
    return True


def validate_smoke(report, manifest_digest, attachments):
    return _validate(report, manifest_digest, attachments, 'release_qualification')


def validate_component_smoke(report, manifest_digest, attachments):
    return _validate(report, manifest_digest, attachments, 'component_integration')
