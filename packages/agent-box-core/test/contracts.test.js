import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import {
  AgentBoxConfigSchema, BoxIdentitySchema, BoxHealthSchema, RosterSchema,
  RelativePathSchema, HttpsEndpointSchema, createBoxIdentity, renameBoxIdentity,
  memoryBankId, isRegistrationReady, parseContract, redact, REDACTED,
} from '../dist/index.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url), 'utf8'));
const config = fixture('config-valid');
const roster = fixture('roster-valid');

for (const [name, schema] of [['config', AgentBoxConfigSchema], ['roster', RosterSchema]]) {
  test(`${name} valid fixture parses and invalid fixtures reject`, () => {
    assert.deepEqual(schema.parse(fixture(`${name}-valid`)), fixture(`${name}-valid`));
    for (const input of fixture(`${name}-invalid`)) assert.equal(schema.safeParse(input).success, false);
  });
}

test('rejects portable-path traversal, encodings, absolute paths and shell metacharacters', () => {
  for (const path of ['../x', 'persona/../../x', '/etc/passwd', 'C:/x', 'C:\\x',
    '\\\\server\\x', 'persona\\..\\x', './x', 'a//b', 'a/', '.', '..',
    '%2e%2e/x', '%252e%252e/x', 'a/%2fetc', 'a\u0000b', 'a\nb', 'a/$(id)', '~/.ssh/id']) {
    assert.equal(RelativePathSchema.safeParse(path).success, false, path);
    assert.equal(AgentBoxConfigSchema.safeParse({ ...config, persona: { instructionsFile: path } }).success, false);
  }
  assert.equal(RelativePathSchema.parse('persona/nested/AGENTS.md'), 'persona/nested/AGENTS.md');
});

test('strict envelopes reject secrets and executable fields at every config level', () => {
  for (const key of ['apiKey', 'token', 'password', 'env', 'hooks', 'plugins', 'boxId', '__proto__']) {
    assert.equal(AgentBoxConfigSchema.safeParse({ ...config, [key]: 'fixture-only' }).success, false);
    for (const nested of ['identity', 'persona', 'memory', 'network']) {
      assert.equal(AgentBoxConfigSchema.safeParse({ ...config, [nested]: { ...config[nested], [key]: 'fixture-only' } }).success, false);
    }
  }
  assert.equal(AgentBoxConfigSchema.safeParse({ ...config, network: { tailscale: 'false' } }).success, false);
  assert.equal(AgentBoxConfigSchema.safeParse({ ...config, memory: { mode: 'external' } }).success, false);
  assert.equal(AgentBoxConfigSchema.safeParse({ ...config, memory: { mode: 'external', endpoint: 'https://memory.example' } }).success, true);
});

test('endpoints reject credentials and insecure or token-bearing URLs without throwing', () => {
  for (const endpoint of ['not a url', 'http://box', 'https://u:p@box', 'https://box?token=x',
    'https://box#x', 'https://box?', 'https://box/#', ' https://box', 'https://box\\@evil']) {
    assert.equal(HttpsEndpointSchema.safeParse(endpoint).success, false, endpoint);
    assert.equal(RosterSchema.safeParse({ ...roster, boxes: [{ ...roster.boxes[0], endpoint }] }).success, false);
  }
});

test('roster rejects duplicates, mutable revisions and secret fields', () => {
  const box = roster.boxes[0];
  const otherId = '6627d292-280b-4d58-9c88-82cf189d9919';
  for (const second of [box, { ...box, boxId: box.boxId.toUpperCase(), endpoint: 'https://other' },
    { ...box, boxId: otherId, endpoint: `${box.endpoint}/` }]) {
    assert.equal(RosterSchema.safeParse({ ...roster, boxes: [box, second] }).success, false);
  }
  for (const patch of [{ configRevision: 'main' }, { capabilities: ['desktop', 'desktop'] },
    { apiCredentialRef: 'Bearer fixture' }, { apiCredentialRef: '/run/secrets/api' },
    { registration: { companyId: otherId, agentId: otherId, token: 'fixture-only' } }]) {
    assert.equal(RosterSchema.safeParse({ ...roster, boxes: [{ ...box, ...patch }] }).success, false);
  }
  const registered = { ...box, registration: { companyId: otherId, agentId: otherId } };
  assert.equal(RosterSchema.safeParse({ ...roster, boxes: [registered] }).success, true);
  assert.equal(RosterSchema.safeParse({ ...roster, boxes: [registered,
    { ...registered, boxId: otherId, endpoint: 'https://other' }] }).success, false);
});

test('identity survives renames and namespaces memory independently of display names', () => {
  const first = createBoxIdentity('helper');
  const second = createBoxIdentity('helper');
  assert.notEqual(first.boxId, second.boxId);
  const renamed = renameBoxIdentity(first, 'new name');
  assert.equal(renamed.boxId, first.boxId);
  assert.equal(first.name, 'helper');
  assert.equal(memoryBankId(renamed.boxId), memoryBankId(first.boxId));
  assert.notEqual(memoryBankId(second.boxId), memoryBankId(first.boxId));
  assert.equal(BoxIdentitySchema.safeParse({ ...first, boxId: '../helper' }).success, false);
  assert.throws(() => createBoxIdentity('   '));
});

function health() {
  return { schemaVersion: 1, boxId: roster.boxes[0].boxId, checkedAt: '2026-09-27T00:00:00Z',
    checks: Object.fromEntries(['container', 'desktop', 'memory', 'api', 'configSource', 'network']
      .map((name) => [name, { status: 'ready', code: 'ok' }])) };
}

test('registration requires each runtime check and explicitly enabled services', () => {
  const required = { configSourceRequired: true, tailscaleEnabled: true };
  assert.equal(isRegistrationReady(health(), required), true);
  for (const component of Object.keys(health().checks)) {
    const input = health();
    input.checks[component] = { status: 'degraded', code: 'unavailable' };
    assert.equal(isRegistrationReady(input, required), false, component);
  }
  const optional = health();
  optional.checks.network = { status: 'disabled', code: 'disabled' };
  optional.checks.configSource = { status: 'degraded', code: 'fallback' };
  assert.equal(isRegistrationReady(optional, { configSourceRequired: false, tailscaleEnabled: false }), true);
  assert.equal(isRegistrationReady(optional, required), false);
  assert.equal(BoxHealthSchema.safeParse({ ...health(), rawError: 'fixture-only' }).success, false);
  const inconsistent = health();
  inconsistent.checks.api.code = 'credential_missing';
  assert.equal(BoxHealthSchema.safeParse(inconsistent).success, false);
});

test('redaction covers nested key variants, arrays, loaded values and cycles without mutation', () => {
  const input = { api_key: 'fixture-key', nested: [{ Authorization: 'fixture-auth',
    text: 'failure: fixture-value', apiCredentialRef: 'helper_api' }], safe: 'okay' };
  const output = redact(input, ['fixture-value', '']);
  assert.deepEqual(output, { api_key: REDACTED, nested: [{ Authorization: REDACTED,
    text: `failure: ${REDACTED}`, apiCredentialRef: REDACTED }], safe: 'okay' });
  assert.equal(input.api_key, 'fixture-key');
  for (const key of ['API_SERVER_KEY', 'TS_AUTHKEY', 'privateKey', 'access_key', 'refreshToken', 'set-cookie']) {
    assert.deepEqual(redact({ [key]: 'fixture-only' }), { [key]: REDACTED });
  }
  const cycle = {}; cycle.self = cycle;
  assert.deepEqual(redact(cycle), { self: '[CIRCULAR]' });
  assert.deepEqual(redact({ 'fixture-value': 'safe' }, ['fixture-value']), { [REDACTED]: 'safe' });
});

test('safe parse errors never expose values or attacker-controlled field names', () => {
  assert.throws(() => parseContract(AgentBoxConfigSchema, { ...config, 'fixture-secret': 'fixture-value' }),
    { message: 'Invalid agent-box contract' });
  assert.deepEqual(parseContract(AgentBoxConfigSchema, config), config);
});
