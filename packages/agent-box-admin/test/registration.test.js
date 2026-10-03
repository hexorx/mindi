/* global structuredClone, TextEncoder */
import { URL } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { OperationStore, runRegistration, hirePayload } from '../dist/index.js';
import { HttpTransport, requestJson } from '../dist/http.js';

const companyId = '10000000-0000-4000-8000-000000000001';
const agentId = '10000000-0000-4000-8000-000000000002';
const approvalId = '10000000-0000-4000-8000-000000000003';
const foreignId = '20000000-0000-4000-8000-000000000001';
const input = {
  companyId, name: 'helper', role: 'engineer', reportsTo: '10000000-0000-4000-8000-000000000004',
  sourceIssueId: '10000000-0000-4000-8000-000000000005', budgetMonthlyCents: 0,
  apiSecretId: '10000000-0000-4000-8000-000000000006', paperclipApiUrl: 'https://paperclip.example',
  box: { boxId: '10000000-0000-4000-8000-000000000007', flavor: 'hermes', endpoint: 'https://box.example/api',
    imageDigest: `sha256:${'a'.repeat(64)}`, configRevision: 'b'.repeat(40), apiCredentialRef: 'box_key',
    capabilities: ['hermes-api', 'desktop', 'memory'], registration: null },
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'roster-test-'));
  const store = new OperationStore(directory);
  t.after(() => store.close());
  const state = { agents: [], approval: null, calls: [], hires: 0, probes: 0 };
  const api = {
    async probe() { state.probes++; },
    async request(method, path, body) {
      state.calls.push([method, path]);
      if (path === '/agents/me') return { companyId };
      if (path === `/agents/${input.reportsTo}`) return { id: input.reportsTo, companyId, status: 'idle' };
      if (path === `/issues/${input.sourceIssueId}`) return { id: input.sourceIssueId, companyId };
      if (path.endsWith('/test-environment')) return { status: 'pass' };
      if (path.endsWith('/agent-hires')) {
        state.hires++;
        const agent = { ...body, id: agentId, companyId, status: state.approval ? 'pending_approval' : 'idle' };
        state.agents.push(agent);
        if (state.timeout) throw new Error('secret raw response must not escape');
        return { agent, approval: state.approval };
      }
      if (path === `/companies/${companyId}/agents`) return state.hide ? [] : state.agents;
      if (path === `/agents/${agentId}`) return state.agents[0];
      if (path === `/companies/${companyId}/approvals`) return [
        { id: foreignId, companyId, payload: { irrelevant: true } }, state.approval,
      ];
      if (path === `/approvals/${approvalId}`) return state.approval;
      throw new Error('unexpected route');
    },
  };
  return { directory, store, api, state };
}
function approval(status = 'pending') { return { id: approvalId, companyId, status, payload: { agentId } }; }

test('dry-run is read-only, needs no operation store or box credential', async (t) => {
  const { api, state } = fixture(t);
  const result = await runRegistration(input, 'register', api, undefined, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.hire.adapterConfig.apiKey.type, 'secret_ref');
  assert.deepEqual(state.calls, [['GET', '/agents/me']]);
  assert.equal(state.probes, 0);
});

test('register then resume is one hire; input and box are unchanged', async (t) => {
  const { api, state, store } = fixture(t);
  const before = JSON.stringify(input);
  assert.equal((await runRegistration(input, 'register', api, store)).phase, 'registered');
  assert.equal((await runRegistration(input, 'register', api, store)).phase, 'registered');
  assert.equal(state.hires, 1);
  assert.equal(state.probes, 1);
  assert.equal(JSON.stringify(input), before);
  assert.ok(state.calls.every(([method, path]) => method === 'GET' || /agent-hires|test-environment/.test(path)));
});

test('pending approval is recovered after timeout and never activated by a patch', async (t) => {
  const { api, state, store } = fixture(t);
  state.approval = approval(); state.timeout = true;
  const pending = await runRegistration(input, 'register', api, store);
  assert.equal(pending.phase, 'pending_approval');
  assert.equal(pending.approvalId, approvalId);
  state.approval.status = 'approved';
  assert.equal((await runRegistration(input, 'reconcile', api, store)).phase, 'pending_approval');
  state.agents[0].status = 'idle';
  assert.equal((await runRegistration(input, 'reconcile', api, store)).phase, 'registered');
  assert.equal(state.hires, 1);
});

test('rejected approval is retained, repeated register cannot rehire', async (t) => {
  const { api, state, store } = fixture(t);
  state.approval = approval();
  await runRegistration(input, 'register', api, store);
  state.approval.status = 'rejected';
  assert.equal((await runRegistration(input, 'register', api, store)).phase, 'rejected');
  assert.equal(state.hires, 1);
});

test('empty lists after timeout do not authorize retry, including a fresh process/store', async (t) => {
  const { api, state, store, directory } = fixture(t);
  state.timeout = true; state.hide = true;
  assert.equal((await runRegistration(input, 'register', api, store)).phase, 'uncertain');
  const reopened = new OperationStore(directory);
  try {
    assert.equal((await runRegistration(input, 'register', api, reopened)).phase, 'uncertain');
    assert.equal(state.hires, 1);
    state.hide = false;
    assert.equal((await runRegistration(input, 'reconcile', api, reopened)).phase, 'registered');
  } finally { reopened.close(); }
});

test('cross-process reservation excludes concurrent registration and recovers on exit', (t) => {
  const { directory, store } = fixture(t);
  store.acquire();
  const script = `import {OperationStore} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    const s = new OperationStore(${JSON.stringify(directory)});
    try { s.acquire(); } catch { process.exitCode = 7; } finally { s.close(); }`;
  assert.equal(spawnSync('node', ['--input-type=module', '-e', script]).status, 7);
  store.release();
  assert.equal(spawnSync('node', ['--input-type=module', '-e', script]).status, 0);
});

test('concurrent workflows cannot both hire', async (t) => {
  const { directory, store, api, state } = fixture(t);
  const other = new OperationStore(directory);
  try {
    const results = await Promise.allSettled([
      runRegistration(input, 'register', api, store), runRegistration(input, 'register', api, other),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(state.hires, 1);
  } finally { other.close(); }
});

test('foreign principal, roster company, endpoint owner, or manager cannot hire', async (t) => {
  for (const mode of ['principal', 'roster', 'endpoint', 'manager']) {
    const { api, state, store } = fixture(t);
    const request = structuredClone(input);
    const original = api.request;
    if (mode === 'principal') api.request = async () => ({ companyId: foreignId });
    if (mode === 'roster') request.box.registration = { companyId: foreignId, agentId };
    if (mode === 'endpoint') state.agents = [{ ...hirePayload(input), id: agentId, companyId, status: 'idle', metadata: {} }];
    if (mode === 'manager') api.request = async (method, path, body) => path === `/agents/${input.reportsTo}` ?
      { id: input.reportsTo, companyId: foreignId, status: 'idle' } : original(method, path, body);
    await assert.rejects(runRegistration(request, 'register', api, store));
    assert.equal(state.hires, 0);
  }
});

test('shared state rejects cross-company reuse and changed operation parameters', async (t) => {
  const { api, state, store } = fixture(t);
  await runRegistration(input, 'register', api, store);
  await assert.rejects(runRegistration({ ...input, name: 'changed' }, 'register', api, store), /operation_input_changed/);
  const request = { ...input, companyId: foreignId };
  const original = api.request;
  api.request = (method, path, body) => path === '/agents/me' ? { companyId: foreignId } : original(method, path, body);
  await assert.rejects(runRegistration(request, 'register', api, store), /box_ownership_conflict/);
  assert.equal(state.hires, 1);
});

test('failed probes and unreadable lists never hire; reconcile never writes a hire', async (t) => {
  const { api, state, store } = fixture(t);
  api.probe = async () => { throw new Error('unhealthy'); };
  await assert.rejects(runRegistration(input, 'register', api, store), /unhealthy/);
  assert.equal((await runRegistration(input, 'reconcile', api, store)).phase, 'reserved');
  assert.equal(state.hires, 0);
  const original = api.request;
  api.request = (method, path, body) => path.endsWith('/agents') ? { items: [] } : original(method, path, body);
  await assert.rejects(runRegistration(input, 'register', api, store));
  assert.equal(state.hires, 0);
});

test('HTTP errors are redacted and authenticated requests cannot redirect', async () => {
  const fetcher = async (_url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-Paperclip-Run-Id'], 'run');
    throw new Error('credential-value');
  };
  await assert.rejects(requestJson('https://example.test', 'credential-value', 'GET', undefined, 'run', fetcher),
    { message: 'request_failed' });
  assert.throws(() => new HttpTransport('https://user:password@example.test', 'key', () => 'key'));
});

test('live probe requires explicit unauthorized response then authenticated healthy response', async () => {
  const calls = [];
  const fetcher = async (_url, options) => {
    calls.push(options);
    return { status: calls.length === 1 ? 401 : 200, ok: true,
      body: { cancel: async () => {}, getReader: () => {
        let done = false;
        return { read: async () => done ? { done: true } :
          (done = true, { done: false, value: new TextEncoder().encode('{"status":"ok"}') }) };
      } } };
  };
  await new HttpTransport('https://paperclip.example', 'pc', () => 'box-secret', undefined, fetcher).probe(input.box);
  assert.equal(calls[0].headers, undefined);
  assert.equal(calls[1].headers.Authorization, 'Bearer box-secret');
  for (const status of [200, 302, 500]) {
    await assert.rejects(new HttpTransport('https://paperclip.example', 'pc', () => 'box-secret', undefined,
      async () => ({ status })).probe(input.box), /box_health_auth_unverified/);
  }
});


test('process exit releases its reservation without losing committed hire intent', async (t) => {
  const { directory, store, api, state } = fixture(t);
  state.timeout = true; state.hide = true;
  await runRegistration(input, 'register', api, store);
  const script = `import {OperationStore} from ${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)};
    const s = new OperationStore(${JSON.stringify(directory)});
    s.acquire(); process.exit(0);`;
  assert.equal(spawnSync('node', ['--input-type=module', '-e', script]).status, 0);
  assert.equal((await runRegistration(input, 'register', api, store)).phase, 'uncertain');
  assert.equal(state.hires, 1);
});

test('malformed hire response reconciles by metadata instead of repeating the write', async (t) => {
  const { store, api, state } = fixture(t);
  const original = api.request;
  api.request = async (method, path, body) => {
    const response = await original(method, path, body);
    return path.endsWith('/agent-hires') ? { unexpected: true } : response;
  };
  assert.equal((await runRegistration(input, 'register', api, store)).phase, 'registered');
  await runRegistration(input, 'register', api, store);
  assert.equal(state.hires, 1);
  const hireIndex = state.calls.findIndex(([, path]) => path.endsWith('/agent-hires'));
  assert.deepEqual(state.calls.slice(hireIndex + 1, hireIndex + 3), [
    ['GET', `/companies/${companyId}/agents`], ['GET', `/agents/${agentId}`],
  ]);
});

test('wrong approval ownership and duplicate mappings fail closed without a new hire', async (t) => {
  const { store, api, state } = fixture(t);
  state.approval = approval();
  await runRegistration(input, 'register', api, store);
  state.approval.companyId = foreignId;
  await assert.rejects(runRegistration(input, 'reconcile', api, store), /approval_ownership_conflict/);
  state.approval.companyId = companyId;
  state.agents.push({ ...state.agents[0], id: foreignId });
  await assert.rejects(runRegistration(input, 'register', api, store), /duplicate_server_mapping/);
  assert.equal(state.hires, 1);
});

test('adapter warnings prevent registration', async (t) => {
  const { store, api, state } = fixture(t);
  const original = api.request;
  api.request = (method, path, body) => path.endsWith('/test-environment') ?
    { status: 'warn' } : original(method, path, body);
  await assert.rejects(runRegistration(input, 'register', api, store), /adapter_environment_failed/);
  assert.equal(state.hires, 0);
});

test('second flavor registers, recovers approval after timeout, and resumes with its adapter', async (t) => {
  const { api, state, store } = fixture(t);
  const request = structuredClone(input);
  request.box.flavor = 'example';
  request.box.adapterType = 'example_gateway';
  request.box.capabilities = ['example-api'];
  state.approval = approval();
  state.timeout = true;
  const preview = await runRegistration(request, 'register', api, undefined, true);
  assert.equal(preview.hire.adapterType, 'example_gateway');
  assert.equal((await runRegistration(request, 'register', api, store)).phase, 'pending_approval');
  state.approval.status = 'approved';
  state.agents[0].status = 'idle';
  assert.equal((await runRegistration(request, 'reconcile', api, store)).phase, 'registered');
  assert.equal((await runRegistration(request, 'register', api, store)).phase, 'registered');
  assert.equal(state.agents[0].adapterType, 'example_gateway');
  assert.ok(state.calls.some(([, path]) => path === `/companies/${companyId}/adapters/example_gateway/test-environment`));
  assert.ok(state.calls.every(([, path]) => !path.includes('hermes')));
  assert.equal(state.hires, 1);
  state.agents[0].adapterType = 'wrong_gateway';
  await assert.rejects(runRegistration(request, 'reconcile', api, store), /agent_ownership_conflict/);
  await assert.rejects(runRegistration({ ...request, box: { ...request.box, adapterType: 'other_gateway' } },
    'register', api, store), /operation_input_changed/);
  assert.equal(state.hires, 1);
});

test('missing or unsafe adapter types fail before API access', async (t) => {
  for (const adapterType of [undefined, '', '../agent-hires', 'x/y', 'x?y', 'x#y', 'A', 'a'.repeat(65)]) {
    const { api, state, store } = fixture(t);
    const request = { ...input, box: { ...input.box, flavor: 'example', adapterType } };
    await assert.rejects(runRegistration(request, 'register', api, store));
    assert.deepEqual(state.calls, []);
  }
});

test('legacy Hermes payload and adapter route remain unchanged', async (t) => {
  const { api, state, store } = fixture(t);
  assert.equal(hirePayload(input).adapterType, 'hermes_gateway');
  await runRegistration(input, 'register', api, store);
  assert.ok(state.calls.some(([, path]) => path === `/companies/${companyId}/adapters/hermes_gateway/test-environment`));
  assert.equal(state.agents[0].adapterType, 'hermes_gateway');
  assert.deepEqual(state.agents[0].adapterConfig, {
    apiBaseUrl: input.box.endpoint,
    apiKey: { type: 'secret_ref', secretId: input.apiSecretId, version: 'latest' },
    sessionKeyStrategy: 'issue', paperclipApiUrl: input.paperclipApiUrl,
  });
});
