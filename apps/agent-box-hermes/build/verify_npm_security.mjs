// Verify every installed copy, then exercise the actual npm CLI without network.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import console from 'node:console';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function verifyTree(root) {
  const semver = createRequire(path.join(root, 'package.json'))('./node_modules/semver');
  const minimums = { 'ip-address': '10.7.1', 'brace-expansion': '5.0.12' };
  const found = new Set();
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Unexpected symlink in npm tree: ' + file);
      if (entry.isDirectory()) walk(file);
      else if (entry.name === 'package.json') {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Object.hasOwn(minimums, manifest.name)) {
          if (!semver.valid(manifest.version) || semver.lt(manifest.version, minimums[manifest.name])) {
            throw new Error('Old npm dependency: ' + file + '@' + manifest.version);
          }
          found.add(manifest.name);
        }
      }
    }
  }
  walk(root);
  for (const name of Object.keys(minimums)) {
    if (!found.has(name)) throw new Error('Missing npm dependency: ' + name);
  }
}

export function smoke(root) {
  verifyTree(root);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-security-'));
  try {
    fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({
      name: 'npm-security-fixture', version: '1.0.0', files: ['index.js'],
    }));
    fs.writeFileSync(path.join(fixture, 'index.js'), 'module.exports = 42;\n');
    const run = (...args) => execFileSync(process.execPath, [
      path.join(root, 'bin/npm-cli.js'), ...args, '--offline', '--ignore-scripts',
      '--no-audit', '--no-fund', '--userconfig=' + path.join(fixture, 'user.npmrc'),
      '--globalconfig=' + path.join(fixture, 'global.npmrc'),
      '--cache=' + path.join(fixture, 'cache'),
    ], { cwd: fixture, encoding: 'utf8', timeout: 30000 });
    console.log('npm --version: ' + run('--version').trim());
    const tree = JSON.parse(run('ls', '--json'));
    if (tree.name !== 'npm-security-fixture' || tree.problems?.length) throw new Error('npm ls failed');
    const packed = Object.values(JSON.parse(run('pack', '--json')));
    if (packed.length !== 1 || !packed[0].files.some(f => f.path === 'index.js')
        || !fs.existsSync(path.join(fixture, packed[0].filename))) throw new Error('npm pack failed: ' + JSON.stringify(packed));
    console.log('npm offline ls/pack and recursive fixed-version checks passed');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  smoke(process.argv[2] || '/usr/local/lib/node_modules/npm');
}
