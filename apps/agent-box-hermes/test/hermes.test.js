import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { URL } from 'node:url';
import { HermesConfigSchema, parseHermesConfig } from '../dist/index.js';

const defaults = JSON.parse(readFileSync(new URL('../defaults/agent-box.json', import.meta.url), 'utf8'));

test('packaged defaults need no GitHub source, credentials or Tailscale', () => {
  const config = parseHermesConfig(defaults);
  assert.equal(config.network.tailscale, false);
  assert.equal(config.memory.mode, 'embedded');
  assert.equal(config.identity.name, 'helper');
  assert.ok(readFileSync(new URL(`../defaults/${config.persona.instructionsFile}`, import.meta.url), 'utf8').length);
});

test('accepts plan model configuration and rejects incorrect flavors or secret settings', () => {
  assert.equal(parseHermesConfig({ ...defaults, hermes: { model: 'operator-selected-model' } }).hermes.model,
    'operator-selected-model');
  for (const patch of [{ flavor: 'other' }, { hermes: { apiKey: 'fixture-only' } },
    { hermes: { model: 'model', token: 'fixture-only' } }, { configSource: { token: 'fixture-only' } }]) {
    assert.equal(HermesConfigSchema.safeParse({ ...defaults, ...patch }).success, false);
  }
  assert.throws(() => parseHermesConfig({ ...defaults, hermes: { model: '' } }),
    { message: 'Invalid agent-box contract' });
});
