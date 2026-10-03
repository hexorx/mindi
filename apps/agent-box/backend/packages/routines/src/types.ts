import type { TaskOutputMetadata } from "@mindi/agent-runtime/task-outputs";
import type { RoutineDeliveryPlan } from "./external-delivery.js";
export type Schedule =
  | { kind: "once"; at: string }
  | { kind: "interval"; minutes: number }
  | { kind: "cron"; expression: string; timezone: string };
export interface RoutineDestination {
  channelId: string;
  branchId?: string;
}
export interface RoutinePublication {
  id: string;
  occurrenceId: string;
  routineId: string;
  destination: RoutineDestination;
  profileId: string;
  state: "pending" | "published" | "blocked";
  messageId?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Routine {
  deliver?: string;
  destination?: RoutineDestination;
  id: string;
  name: string;
  prompt: string;
  profileId: string;
  boardId: string;
  schedule: Schedule;
  enabled: boolean;
  deleted: boolean;
  revision: number;
  createdAt: string;
  nextRunAt: number | null;
}
export interface Occurrence {
  outputs?: TaskOutputMetadata[];
  deliveryPlan?: RoutineDeliveryPlan;
  id: string;
  routineId: string;
  source: "manual" | "scheduled";
  scheduledAt: number;
  snapshot: Routine;
  state:
    | "queued"
    | "running"
    | "review"
    | "blocked"
    | "cancelled"
    | "attention_required";
  createdAt: string;
  endedAt?: string;
  summary?: string;
  taskId?: string;
  attemptId?: string;
  priorAttemptIds?: string[];
}
export interface PageInput {
  after?: string;
  limit?: number;
}
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
export interface CreateRoutine {
  deliver?: string | null;
  destination?: RoutineDestination | null;
  name: string;
  prompt: string;
  profileId: string;
  boardId: string;
  schedule: Schedule;
  idempotencyKey: string;
  enabled?: boolean;
}
export interface UpdateRoutine {
  deliver?: string | null;
  destination?: RoutineDestination | null;
  expectedRevision: number;
  name?: string;
  prompt?: string;
  schedule?: Schedule;
  enabled?: boolean;
  deleted?: boolean;
}
export class RoutineError extends Error {
  constructor(
    public readonly code:
      "invalid" | "not_found" | "conflict" | "closed" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "RoutineError";
  }
}
export function invalid(message: string): never {
  throw new RoutineError("invalid", message);
}
export function plain(
  value: unknown,
  fields: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).some(
      (k) =>
        typeof k !== "string" ||
        !fields.includes(k) ||
        !("value" in Object.getOwnPropertyDescriptor(value, k)!),
    )
  )
    invalid("Invalid input fields");
}
export function str(value: unknown, field: string, max = 200): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    invalid(`Invalid ${field}`);
  return value;
}
