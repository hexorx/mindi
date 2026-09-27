import assert from 'node:assert/strict';
import test from 'node:test';
import { greet } from '../dist/index.js';

test('greets Mindi by default', () => {
  assert.equal(greet(), 'Hello, Mindi!');
});

test('greets a supplied name', () => {
  assert.equal(greet('Josh'), 'Hello, Josh!');
});
