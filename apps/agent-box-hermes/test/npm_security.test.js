import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { verifyTree } from '../build/verify_npm_security.mjs';

test('npm tree rejects nested old copies and missing packages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-tree-test-'));
  try {
    const require = createRequire(import.meta.url);
    const semver = path.dirname(require.resolve('semver/package.json', {
      paths: ['/usr/local/lib/node_modules/npm', '/usr/lib/node_modules/npm'],
    }));
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.cpSync(semver, path.join(root, 'node_modules/semver'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"npm"}');
    const put = (dir, name, version) => {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ name, version }));
    };
    put('node_modules/ip-address', 'ip-address', '10.7.1');
    assert.throws(() => verifyTree(root), /Missing npm dependency: brace-expansion/);
    put('node_modules/brace-expansion', 'brace-expansion', '5.0.12');
    verifyTree(root);
    put('node_modules/fixture/node_modules/ip-address', 'ip-address', '10.5.0');
    assert.throws(() => verifyTree(root), /Old npm dependency/);
    put('node_modules/fixture/node_modules/ip-address', 'ip-address', '10.7.1');
    put('node_modules/fixture/node_modules/brace-expansion', 'brace-expansion', '5.0.11');
    assert.throws(() => verifyTree(root), /Old npm dependency/);
    put('node_modules/fixture/node_modules/brace-expansion', 'brace-expansion', '5.0.12');
    verifyTree(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
