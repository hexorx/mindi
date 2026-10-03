import { createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { RosterBoxSchema, HttpsEndpointSchema } from '@mindi/agent-box-core';

import { legacyFlavorAdapters } from './flavors.js';

const uuid = z.uuid().transform((v) => v.toLowerCase());
export const RequestSchema = z.strictObject({
  companyId: uuid,
  box: RosterBoxSchema,
  name: z.string().trim().min(1).max(128),
  role: z.enum(['ceo', 'cto', 'cmo', 'cfo', 'security', 'engineer', 'designer', 'pm', 'qa', 'devops', 'researcher', 'general']),
  reportsTo: uuid,
  sourceIssueId: uuid,
  budgetMonthlyCents: z.number().int().nonnegative(),
  // Symbolic roster reference is resolved to this existing company secret, never a value.
  apiSecretId: uuid,
  paperclipApiUrl: HttpsEndpointSchema,
});
export type RegistrationRequest = z.infer<typeof RequestSchema>;
const AgentSchema = z.object({
  id: uuid, companyId: uuid, status: z.string(),
  adapterType: z.string(), adapterConfig: z.record(z.string(), z.unknown()).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});
type Agent = z.infer<typeof AgentSchema>;
const ApprovalSchema = z.object({
  id: uuid, companyId: uuid, status: z.string(),
  payload: z.object({ agentId: uuid }),
});
const OperationSchema = z.strictObject({
  key: z.string(), companyId: uuid, boxId: uuid, endpoint: z.string(), fingerprint: z.string(),
  phase: z.enum(['reserved', 'uncertain', 'pending_approval', 'registered', 'rejected', 'inactive']),
  agentId: uuid.optional(), approvalId: uuid.optional(),
  lastError: z.enum(['hire_outcome_unknown', 'server_read_failed']).optional(),
});
export type Operation = z.infer<typeof OperationSchema>;
export interface Transport {
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown>;
  // Must authenticate using the selected box credential. No box writes.
  probe(box: RegistrationRequest['box']): Promise<void>;
}
function fail(code: string): never { throw new Error(code); }
function endpoint(value: string): string { return new URL(value).href.replace(/\/$/, ''); }
function key(r: RegistrationRequest): string { return `${r.companyId}:${r.box.boxId}`; }
function fingerprint(r: RegistrationRequest): string {
  return createHash('sha256').update(JSON.stringify(r)).digest('hex');
}

/** One trusted, shared local state directory for every operator and company.
 * Separate lock DB holds a transaction over network awaits; state DB commits
 * before a hire. Process death releases the lock without discarding intent.
 * Never run independent copies of this directory or place it on NFS.
 */
export class OperationStore {
  private state: DatabaseSync;
  private lock: DatabaseSync;
  private held = false;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lock = new DatabaseSync(join(directory, 'reservation.sqlite'));
    this.state = new DatabaseSync(join(directory, 'operations.sqlite'));
    for (const file of ['reservation.sqlite', 'operations.sqlite']) chmodSync(join(directory, file), 0o600);
    this.state.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS operations (
        key TEXT PRIMARY KEY, box_id TEXT UNIQUE NOT NULL,
        endpoint TEXT UNIQUE NOT NULL, record TEXT NOT NULL
      )`);
  }
  acquire(): void {
    if (this.held) fail('reservation_busy');
    try { this.lock.exec('BEGIN IMMEDIATE'); } catch { fail('reservation_busy'); }
    this.held = true;
  }
  release(): void { if (this.held) { this.lock.exec('ROLLBACK'); this.held = false; } }
  read(r: RegistrationRequest): Operation | undefined {
    const row = this.state.prepare('SELECT record FROM operations WHERE box_id = ? OR endpoint = ?')
      .get(r.box.boxId, endpoint(r.box.endpoint));
    if (!row) return undefined;
    const op = OperationSchema.parse(JSON.parse(String(row.record)));
    if (op.key !== key(r) || op.endpoint !== endpoint(r.box.endpoint)) fail('box_ownership_conflict');
    if (op.fingerprint !== fingerprint(r)) fail('operation_input_changed');
    return op;
  }
  save(op: Operation): void {
    if (!this.held) fail('reservation_required');
    const record = OperationSchema.parse(op);
    this.state.prepare(`INSERT INTO operations VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET record = excluded.record`)
      .run(record.key, record.boxId, record.endpoint, JSON.stringify(record));
  }
  close(): void { this.release(); this.state.close(); this.lock.close(); }
}

function mapping(agent: Agent): Record<string, unknown> | undefined {
  const value = agent.metadata?.agentBoxRegistration;
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function adapterType(r: RegistrationRequest): string {
  return r.box.adapterType ?? legacyFlavorAdapters.get(r.box.flavor) ?? fail('unsupported_flavor');
}
function validateAgent(agent: Agent, r: RegistrationRequest): void {
  const meta = mapping(agent);
  if (agent.companyId !== r.companyId || agent.adapterType !== adapterType(r) ||
      meta?.boxId !== r.box.boxId || meta?.operationKey !== key(r) ||
      meta?.companyId !== r.companyId ||
      typeof agent.adapterConfig?.apiBaseUrl !== 'string' ||
      endpoint(agent.adapterConfig.apiBaseUrl) !== endpoint(r.box.endpoint)) fail('agent_ownership_conflict');
  if (r.box.registration && r.box.registration.agentId !== agent.id) fail('agent_ownership_conflict');
}

async function reconcileServer(r: RegistrationRequest, op: Operation, api: Transport): Promise<Operation> {
  // Read the entire company roster, including pending agents. Never infer absence
  // from a failed request or an unexpected/paginated response shape.
  const agents = z.array(AgentSchema).parse(await api.request('GET', `/companies/${r.companyId}/agents`));
  if (agents.some((a) => a.companyId !== r.companyId)) fail('company_mismatch');
  const matches = agents.filter((a) => mapping(a)?.boxId === r.box.boxId ||
    mapping(a)?.operationKey === key(r) ||
    (typeof a.adapterConfig?.apiBaseUrl === 'string' && endpoint(a.adapterConfig.apiBaseUrl) === endpoint(r.box.endpoint)));
  if (matches.length > 1) fail('duplicate_server_mapping');
  const id = op.agentId ?? r.box.registration?.agentId ?? matches[0]?.id;
  if (!id) return op;
  if (matches[0] && matches[0].id !== id) fail('agent_ownership_conflict');
  const agent = AgentSchema.parse(await api.request('GET', `/agents/${id}`));
  if (agent.id !== id) fail('agent_ownership_conflict');
  validateAgent(agent, r);
  op = { ...op, agentId: id };
  // Recover an approval ID lost with a timed-out hire response.
  if (!op.approvalId && agent.status === 'pending_approval') {
    const approvals = z.array(z.object({ id: uuid, companyId: uuid, payload: z.record(z.string(), z.unknown()) })).parse(await api.request('GET', `/companies/${r.companyId}/approvals`));
    const matches = approvals.filter((a) => a.companyId === r.companyId && a.payload.agentId === id);
    if (matches.length !== 1) fail('approval_reconciliation_required');
    op.approvalId = matches[0]!.id;
  }
  if (op.approvalId) {
    const approval = ApprovalSchema.parse(await api.request('GET', `/approvals/${op.approvalId}`));
    if (approval.id !== op.approvalId || approval.companyId !== r.companyId || approval.payload.agentId !== id)
      fail('approval_ownership_conflict');
    if (approval.status === 'rejected') return { ...op, phase: 'rejected', lastError: undefined };
    if (approval.status !== 'approved') return { ...op, phase: 'pending_approval', lastError: undefined };
  }
  return { ...op, phase: agent.status === 'pending_approval' ? 'pending_approval' :
    ['active', 'idle', 'running'].includes(agent.status) ? 'registered' : 'inactive', lastError: undefined };
}

export function hirePayload(r: RegistrationRequest) {
  return {
    name: r.name, role: r.role, reportsTo: r.reportsTo, sourceIssueId: r.sourceIssueId,
    budgetMonthlyCents: r.budgetMonthlyCents, adapterType: adapterType(r),
    adapterConfig: { apiBaseUrl: endpoint(r.box.endpoint),
      apiKey: { type: 'secret_ref', secretId: r.apiSecretId, version: 'latest' },
      sessionKeyStrategy: 'issue', paperclipApiUrl: r.paperclipApiUrl },
    metadata: { agentBoxRegistration: { operationKey: key(r), companyId: r.companyId,
      boxId: r.box.boxId, imageDigest: r.box.imageDigest, configRevision: r.box.configRevision } },
  };
}

export async function runRegistration(input: unknown, command: 'register' | 'reconcile',
  api: Transport, store?: OperationStore, dryRun = false): Promise<unknown> {
  const r = RequestSchema.parse(input);
  adapterType(r); // Resolve before any API access or state reservation.
  if (r.box.registration && r.box.registration.companyId !== r.companyId) fail('company_mismatch');
  // Authenticated principal, not caller-supplied company scope.
  const principal = z.object({ companyId: uuid }).parse(await api.request('GET', '/agents/me'));
  if (principal.companyId !== r.companyId) fail('company_mismatch');
  if (dryRun) return { dryRun: true, operationKey: key(r), hire: hirePayload(r) };
  if (!store) fail('state_directory_required');
  store.acquire();
  try {
    let op = store.read(r) ?? { key: key(r), companyId: r.companyId, boxId: r.box.boxId,
      endpoint: endpoint(r.box.endpoint), fingerprint: fingerprint(r), phase: 'reserved' as const };
    op = await reconcileServer(r, op, api);
    store.save(op);
    if (command === 'reconcile' || op.phase !== 'reserved') return op;
    const manager = z.object({ id: uuid, companyId: uuid, status: z.string() })
      .parse(await api.request('GET', `/agents/${r.reportsTo}`));
    if (manager.id !== r.reportsTo || manager.companyId !== r.companyId ||
        ['pending_approval', 'terminated'].includes(manager.status)) fail('invalid_manager');
    const issue = z.object({ id: uuid, companyId: uuid })
      .parse(await api.request('GET', `/issues/${r.sourceIssueId}`));
    if (issue.id !== r.sourceIssueId || issue.companyId !== r.companyId) fail('company_mismatch');
    await api.probe(r.box);
    const environment = z.object({ status: z.literal('pass') }).safeParse(await api.request('POST',
      `/companies/${r.companyId}/adapters/${adapterType(r)}/test-environment`, { adapterConfig: hirePayload(r).adapterConfig }));
    if (!environment.success) fail('adapter_environment_failed');
    // Commit intent BEFORE dispatch. Neither timeouts nor process crashes grant
    // permission to submit another hire, even if the first list is still empty.
    op = { ...op, phase: 'uncertain', lastError: 'hire_outcome_unknown' };
    store.save(op);
    try {
      const response = z.object({ agent: AgentSchema, approval: ApprovalSchema.nullable() })
        .parse(await api.request('POST', `/companies/${r.companyId}/agent-hires`, hirePayload(r)));
      validateAgent(response.agent, r);
      if (response.approval && (response.approval.companyId !== r.companyId || response.approval.payload.agentId !== response.agent.id))
        fail('approval_ownership_conflict');
      op = { ...op, agentId: response.agent.id, approvalId: response.approval?.id };
      store.save(op);
    } catch { /* Preserve uncertainty; read server state before any further action. */ }
    try { op = await reconcileServer(r, op, api); }
    catch { op = { ...op, lastError: 'server_read_failed' }; }
    store.save(op);
    return op;
  } finally { store.release(); }
}
