import type { TaskOutputMetadata } from "@mindi/agent-runtime/task-outputs";
export type TaskStatus =
  | "triage"
  | "todo"
  | "ready"
  | "running"
  | "blocked"
  | "review"
  | "done"
  | "archived"
  | "attention_required";
export interface Board {
  messagingChannelId: string | null;
  id: string;
  name: string;
  description: string;
  archived: boolean;
  dispatchMode: "auto" | "manual";
  revision: number;
  createdAt: string;
}
export interface Task {
  maxRetries?: number | null;
  /** Trusted scheduler ownership; ordinary board dispatch must not admit it. */
  routineOccurrenceId?: string;
  id: string;
  boardId: string;
  title: string;
  body: string;
  assignee: string | null;
  priority: number;
  parentId: string | null;
  dependencies: string[];
  completionContract: string;
  status: TaskStatus;
  revision: number;
  createdAt: string;
}
/** Immutable observation of an actual persisted status change; no inferred actor. */
export interface TaskActivity {
  id: string;
  taskId: string;
  boardId: string;
  channelId: string | null;
  title: string;
  from: TaskStatus;
  to: TaskStatus;
  revision: number;
  createdAt: string;
}
export interface TaskComment {
  id: string;
  taskId: string;
  author: string;
  body: string;
  createdAt: string;
}
export interface AttemptReview {
  attemptId: string;
  decision: "accept" | "changes";
  reason: string;
  recordedAt: string;
  taskRevision: number;
}
export interface Attempt {
  retryOf?: string;
  retry?: { phase: "ready" | "triage"; taskRevision: number };
  protocolBudget?: {
    attemptId: string;
    policyVersion: 1;
    reason: "missing_task_result";
    count: number;
    limit: number;
    limitSource: "builtin" | "task";
    disposition: "below_limit" | "exhausted";
  };
  termination?: {
    runId: string;
    threadId: string;
    state: "completed" | "failed" | "cancelled";
    errorCode?: string;
  };
  review?: AttemptReview;
  outputs?: TaskOutputMetadata[];
  purpose?: "decompose";
  threadId?: string;
  runId?: string;
  cancellationRequestedAt?: string;
  id: string;
  taskId: string;
  state: "running" | "review" | "blocked" | "attention_required" | "reconciled";
  snapshot: Task;
  createdAt: string;
  leaseExpiresAt: number;
  endedAt?: string;
  summary?: string;
}
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
export interface PageInput {
  after?: string;
  limit?: number;
}
export interface CreateTask {
  maxRetries?: number | null;
  routineOccurrenceId?: string;
  boardId: string;
  title: string;
  body?: string;
  assignee?: string | null;
  priority?: number;
  parentId?: string | null;
  completionContract?: string;
  status?: "triage" | "todo";
  idempotencyKey: string;
}
export interface UpdateTask {
  maxRetries?: number | null;
  idempotencyKey?: string;
  expectedRevision: number;
  title?: string;
  body?: string;
  assignee?: string | null;
  priority?: number;
  parentId?: string | null;
  completionContract?: string;
  dependencies?: string[];
}
export class TaskError extends Error {
  constructor(
    public readonly code:
      "invalid" | "not_found" | "conflict" | "closed" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "TaskError";
  }
}

/** Durable identity and recoverable channel projection; comment bodies stay in TaskComment. */
export interface TaskDiscussion {
  id: string;
  taskId: string;
  boardId: string;
  channelId: string;
  title: string;
  createdAt: string;
  publication:
    | { status: "pending" }
    | { status: "published"; messageId: string; publishedAt: string };
}
export interface DiscussionCommentInput {
  channelId: string;
  author: string;
  body: string;
  idempotencyKey: string;
}
export interface DiscussionCommentResult {
  comment: TaskComment;
  discussion: TaskDiscussion;
}
