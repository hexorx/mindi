import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

test('built app resolves the core workspace package and prints its greeting', () => {
  const output = execFileSync('node', [fileURLToPath(new URL('../dist/index.js', import.meta.url))], { encoding: 'utf8' });
  assert.equal(output.trim(), 'Hello, Mindi!');
});
