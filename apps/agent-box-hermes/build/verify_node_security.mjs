// Validate the fixed packages against the real inherited dependency graph.
import fs from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import path from 'node:path';
import { createRequire } from 'node:module';
const semver = createRequire(import.meta.url)('/usr/local/lib/node_modules/npm/node_modules/semver');
const lock = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const entry of lock.packages) {
  for (const target of entry.targets) {
    const manifest = path.join(target.path, 'package.json');
    const installed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (installed.name !== entry.name || installed.version !== entry.version) {
      throw new Error(`Wrong installed package: ${target.path}`);
    }
    if (installed.engines?.node && !semver.satisfies(process.versions.node, installed.engines.node)) {
      throw new Error(`Unsupported Node version: ${target.path}`);
    }
    const localRequire = createRequire(manifest);
    for (const [name, range] of Object.entries(installed.dependencies || {})) {
      // Resolve package manifests manually: some packages hide them with exports.
      const dirs = localRequire.resolve.paths(name) || [];
      const file = dirs.map(dir => path.join(dir, name, 'package.json')).find(file => fs.existsSync(file));
      if (!file || !semver.satisfies(JSON.parse(fs.readFileSync(file, 'utf8')).version, range)) {
        throw new Error(`Unsatisfied dependency ${name}@${range}: ${target.path}`);
      }
    }
  }
}
console.log('Inherited Node security overlay: versions, engines and dependencies verified');
