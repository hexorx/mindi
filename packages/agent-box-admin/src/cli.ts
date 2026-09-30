#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { OperationStore, runRegistration } from './index.js';
import { HttpTransport } from './http.js';

let store: OperationStore | undefined;
try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    request: { type: 'string' }, state: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
  } });
  const command = positionals[0];
  if (positionals.length !== 1 || !['register', 'reconcile'].includes(command ?? '') || !values.request ||
      (!values['dry-run'] && !values.state)) throw new Error('usage');
  const input: unknown = JSON.parse(readFileSync(values.request, 'utf8'));
  const api = new HttpTransport(process.env.PAPERCLIP_API_URL ?? '', process.env.PAPERCLIP_API_KEY ?? '',
    (ref) => process.env[`AGENT_BOX_CREDENTIAL_${ref}`] ?? '', process.env.PAPERCLIP_RUN_ID);
  if (!values['dry-run']) store = new OperationStore(values.state!);
  const result = await runRegistration(input, command as 'register' | 'reconcile', api, store, values['dry-run']);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (result && typeof result === 'object' && 'phase' in result && result.phase === 'uncertain') process.exitCode = 2;
} catch {
  // Validation and HTTP errors may carry input/response values. Never emit them.
  process.stderr.write('Registration did not complete. Check the secret-free request, access and durable operation state.\n');
  process.exitCode = 1;
} finally { store?.close(); }
