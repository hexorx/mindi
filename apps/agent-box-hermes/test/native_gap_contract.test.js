/* global fetch */
import process from 'node:process';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

// Point to the real adapter's src/gateway/server/execute.ts (use tsx),
// or a freshly built dist/gateway/server/execute.js with resolvable dependencies.
// Ordinary CI runs the HTTP regressions; this cross-repository proof is opt-in.
for (const source of ['status', 'event', 'payload']) {
  test(`real adapter: polling wins after native ${source} gap`, {
    skip: !process.env.HERMES_ADAPTER_EXECUTE, timeout: 15000,
  }, async () => {
    const { execute } = await import(pathToFileURL(process.env.HERMES_ADAPTER_EXECUTE));
    const child = spawn('python3', ['-B', fileURLToPath(new URL('native_gap_fixture.py', import.meta.url)), source],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const lines = createInterface({ input: child.stdout });
    try {
      const base = await Promise.race([
        once(lines, 'line').then(([line]) => String(line)),
        once(child, 'exit').then(() => { throw new Error(`Fixture exited: ${stderr}`); }),
      ]);
      const config = { apiBaseUrl: base, apiKey: 'offline-contract-key', timeoutSec: 5, pollIntervalMs: 250 };
      const logs = [];
      const result = await execute({
        runId: 'native-gap-contract',
        agent: { id: 'agent', companyId: 'company', name: 'test', adapterType: 'hermes_gateway', adapterConfig: config },
        runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
        config, context: {}, onLog: async (channel, message) => { logs.push(message); },
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.errorCode, 'hermes_gateway_event_gap');
      assert.equal(result.resultJson.event_gap, true);
      assert.equal(result.resultJson.output, 'authoritative output');
      assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 0 });
      assert.equal(logs.some(line => line.includes('[hermes-gateway:event]')), false);
      const headers = { Authorization: 'Bearer offline-contract-key' };
      const response = await fetch(`${base}/v1/runs/${result.resultJson.run_id}`, { headers });
      assert.equal(response.status, 200);
      const status = await response.json();
      // The adapter also rejects missing SSE; prove the shim itself retained loss.
      assert.equal(status.event_gap, true);
      assert.equal(status.status, 'completed');
      assert.equal(status.output, 'authoritative output');
      assert.deepEqual(status.usage, { input_tokens: 7 });
      const evidence = await fetch(`${base}/test/evidence`, { headers }).then(r => r.json());
      assert.ok(evidence.polls >= 2);
      assert.ok(evidence.downstream_events >= 1);
      assert.equal(evidence.snapshots.length, 1);
      assert.equal(evidence.snapshots[0].event_gap, true);
      assert.deepEqual(evidence.snapshots[0].status, status);
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
  });
}
