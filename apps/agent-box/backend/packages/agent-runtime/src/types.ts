import type {
  ConversationOutputContext,
  ConversationOutputMetadata,
} from "./conversation-outputs.js";
import type { TaskOutputMetadata } from "./task-outputs.js";
export type AttachmentScope =
  | { kind: "thread"; threadId: string; profileId: string }
  | {
      kind: "channel";
      channelId: string;
      branchId?: string;
      profileId: string;
    };
export interface AttachmentMetadata {
  id: string;
  scope: AttachmentScope;
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  createdAt: string;
}
export interface ResolvedAttachment extends AttachmentMetadata {
  data: string;
}
/** Server-owned provenance, never accepted from a turn submission. */
export interface WorkerAttachmentSource {
  threadId: string;
  attachmentIds: string[];
}
export interface TaskContext {
  taskId: string;
  attemptId: string;
}
export interface TaskOutcome {
  outputs?: TaskOutputMetadata[];
  outcome: "review" | "blocked";
  summary: string;
}
export type ApprovalMode = "always-ask" | "write" | "yolo";
export function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "always-ask" || value === "write" || value === "yolo";
}
export interface AgentProfile {
  id: string;
  instructions: string;
  tools?: string[];
  approvalMode?: ApprovalMode;
  modelIds: string[];
  defaultModelId: string;
  memory?: { url: string; bankId: string };
}
export interface WorkerInput {
  conversation?: ConversationOutputContext;
  /** Trusted run-owned export directory, never supplied by turn input. */
  outputDirectory?: string;
  attachments?: ResolvedAttachment[];
  /** Run-owned lazy access to immutable prior conversation admissions. */
  resolveHistoricalAttachment?(id: string): ResolvedAttachment;
  task?: TaskContext;
  requestInteraction?(
    request: InteractionRequest,
    signal?: AbortSignal,
  ): Promise<InteractionResponse>;
  threadId: string;
  runId: string;
  profile: AgentProfile;
  modelId: string;
  text: string;
  sessionPath?: string;
  signal: AbortSignal;
}
export type WorkerEvent =
  | { type: "conversation_output"; outputPaths: string[] }
  | ({ type: "task_outcome"; outputPaths?: string[] } & Omit<
      TaskOutcome,
      "outputs"
    >)
  | { type: "text"; text: string }
  | { type: "worker_started"; pid: number; ownership?: "guardian" }
  | { type: "tool"; name: string; state: "started" | "completed" | "failed" };
export interface BranchPoint {
  entryId: string;
  text: string;
}
export interface AgentWorker {
  branchPoints?(input: {
    profile: AgentProfile;
    sessionPath: string;
    signal: AbortSignal;
  }): Promise<BranchPoint[]>;
  run(
    input: WorkerInput,
    emit: (event: WorkerEvent) => void,
  ): Promise<{ sessionPath: string; userEntryId?: string }>;
  fork(input: {
    onProcess?(pid: number, ownership?: "guardian"): void;
    threadId: string;
    profile: AgentProfile;
    sessionPath: string;
    entryId: string;
    signal: AbortSignal;
  }): Promise<{ sessionPath: string }>;
}
export type ThreadOwner =
  | { kind: "operator" }
  | { kind: "task" | "channel" | "voice"; id: string }
  | { kind: "unresolved" };
export interface Thread {
  replyContext?: ReplyContext;
  owner?: ThreadOwner;
  id: string;
  profileId: string;
  createdAt: string;
  sessionPath?: string;
  parentId?: string;
  branchEntryId?: string;
}
export class RuntimeError extends Error {
  constructor(
    public readonly code:
      | "invalid"
      | "not_found"
      | "conflict"
      | "closed"
      | "unavailable"
      | "timeout"
      | "cancelled"
      | "cleanup_uncertain"
      | "interrupted",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}
export type RunState =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "attention_required";
export interface Run {
  conversation?: ConversationOutputContext;
  conversationOutputs?: ConversationOutputMetadata[];
  /** A lost guardian does not prove its descendants stopped. */
  workerOwnership?: "guardian";
  attachments?: AttachmentMetadata[];
  /** Private immutable worker context, excluded from public run projections. */
  workerAttachmentSources?: WorkerAttachmentSource[];
  workerAttachmentMetadata?: AttachmentMetadata[];
  /** OMP user entry for this turn; branching here excludes this turn. */
  userEntryId?: string;
  task?: TaskContext;
  taskOutcome?: TaskOutcome;
  reconciliation?: { reason: string; at: string };
  text: string;
  id: string;
  threadId: string;
  state: RunState;
  modelId: string;
  profileRevision: string;
  memoryState: "disabled" | "unverified";
  createdAt: string;
  endedAt?: string;
  error?: string;
  errorCode?: RuntimeError["code"] | "worker_failed";
}
export type RunEventData =
  | ({ type: "task_outcome" } & TaskOutcome)
  | { type: "interaction"; interaction: Interaction }
  | { type: "state"; state: RunState }
  | { type: "text"; text: string }
  | { type: "tool"; name: string; state: "started" | "completed" | "failed" };
export type RunEvent = {
  version: 1;
  runId: string;
  sequence: number;
} & RunEventData;
export interface TurnInput {
  attachmentIds?: string[];
  task?: TaskContext;
  threadId: string;
  text: string;
  idempotencyKey: string;
  modelId?: string;
}
export interface ProfileView {
  id: string;
  instructions: string;
  tools: string[];
  availableTools: string[];
  approvalMode: ApprovalMode;
  modelIds: string[];
  defaultModelId: string;
  revision: string;
  managed: boolean;
}
export interface CreateProfileInput {
  id: string;
  templateId: string;
  instructions: string;
}
export interface UpdateProfileInput {
  expectedRevision: string;
  instructions?: string;
  defaultModelId?: string;
  tools?: string[];
  approvalMode?: ApprovalMode;
}

/** Producer identity, not a classification inferred from prompt or response format. */
export type InteractionSource =
  | "acp-permission"
  | "coordinator-tool-approval"
  | "coordinator-question"
  | "omp-confirm"
  | "omp-select"
  | "omp-input"
  | "omp-editor"
  | "omp-question";
export type InteractionRequest = (
  | {
      kind: "choice";
      prompt: string;
      choices: Array<{ id: string; label: string }>;
    }
  | { kind: "text"; prompt: string; maxLength?: number }
  | {
      kind: "question";
      prompt: string;
      choices: Array<{ id: string; label: string }>;
      multiple: boolean;
      allowCustom: boolean;
    }
) & { timeoutMs?: number; source?: InteractionSource };
export type InteractionResponse =
  | { choiceId: string }
  | { text: string }
  | { choiceIds: string[]; text?: string }
  | { cancelled: true };
export interface Interaction {
  id: string;
  runId: string;
  request: InteractionRequest;
  state: "pending" | "answered" | "cancelled" | "expired" | "interrupted";
  createdAt: string;
  expiresAt: string;
  /** Explicit operator decision. Automatic cancellation has no stored response. */
  response?: InteractionResponse;
}

export interface ForkOperation {
  workerOwnership?: "guardian";
  /** The process owner could not confirm descendant cleanup. */
  cleanupUnconfirmed?: true;
  replyToRole?: "user" | "assistant";
  replyToRunId?: string;
  replyContext?: ReplyContext;
  id: string;
  parentThreadId: string;
  entryId: string;
  childThreadId: string;
  state: "running" | "completed" | "attention_required" | "cancelled";
  createdAt: string;
  endedAt?: string;
  reconciliation?: { reason: string; at: string };
}
/** Immutable selected turn; quoted as data on explicit reply submissions. */
export interface ReplyContext {
  /** Public metadata for files attached to the selected turn itself. */
  attachments?: AttachmentMetadata[];
  /** Private server-owned inherited attachment context. */
  workerAttachmentSources?: WorkerAttachmentSource[];
  workerAttachmentMetadata?: AttachmentMetadata[];
  /** Omitted on existing assistant replies. */
  role?: "user" | "assistant";
  version: 1;
  parentThreadId: string;
  runId: string;
  entryId: string;
  prompt: string;
  /** Exact submitted prompt when the selected run itself inherited reply context. */
  contextPrompt?: string;
  assistantText?: string;
  createdAt: string;
  endedAt?: string;
}
export interface ThreadSummary {
  threadId: string;
  messageCount: number;
  participants: Array<"user" | "assistant">;
  running: boolean;
}
