import { setImmediate as yieldTurn } from "node:timers/promises";
import { RuntimeError } from "@mindi/agent-runtime";
import { TaskError, type TaskStore, type Task } from "@mindi/tasks";
import type { TaskRunner } from "./index.js";

export interface DispatchStatus {
  boardId: string;
  mode: "auto" | "manual";
  revision: number;
  phase: "auto" | "pausing" | "paused" | "attention_required" | "stopped";
  /** Board selections being drained, not native worker executions. */
  scheduling: number;
  fault?: { code: "unavailable"; message: string };
}

/** One application-owned scheduler. Closing it never cancels native work. */
export class TaskDispatcher {
  private readonly tasks: TaskStore;
  private readonly runner: TaskRunner;
  private readonly intervalMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private readonly scheduling = new Set<string>();
  private closed = false;
  private fault?: DispatchStatus["fault"];

  constructor(options: {
    tasks: TaskStore;
    runner: TaskRunner;
    intervalMs?: number;
  }) {
    this.tasks = options.tasks;
    this.runner = options.runner;
    this.intervalMs = options.intervalMs ?? 1000;
    if (
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 100 ||
      this.intervalMs > 60000
    )
      throw new TaskError("invalid", "Invalid task dispatcher interval");
  }
  status(boardId: string): DispatchStatus {
    const board = this.tasks.getBoard(boardId);
    const scheduling = this.scheduling.has(boardId) ? 1 : 0;
    return {
      boardId,
      mode: board.dispatchMode,
      revision: board.revision,
      phase: this.closed
        ? "stopped"
        : this.fault
          ? "attention_required"
          : board.archived || board.dispatchMode === "manual"
            ? scheduling
              ? "pausing"
              : "paused"
            : "auto",
      scheduling,
      ...(this.fault ? { fault: { ...this.fault } } : {}),
    };
  }
  private lastCompletedSweepAt?: number;
  /** Local loop evidence only; this does not verify external worker access. */
  serviceObservation() {
    return {
      phase: this.closed
        ? ("stopped" as const)
        : this.fault
          ? ("attention_required" as const)
          : this.lastCompletedSweepAt === undefined
            ? ("unknown" as const)
            : ("ready" as const),
      lastCompletedSweepAt: this.lastCompletedSweepAt,
    };
  }
  start(): void {
    if (this.closed || this.fault || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    if (this.closed || this.fault) return Promise.resolve();
    this.active = Promise.resolve()
      .then(() => this.sweep())
      .then(() => {
        this.lastCompletedSweepAt = Date.now();
      })
      .catch(() => {
        this.fault = {
          code: "unavailable",
          message: "Automatic task dispatch requires operator attention",
        };
        clearInterval(this.timer);
        this.timer = undefined;
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
  private async sweep(): Promise<void> {
    let after: string | undefined;
    do {
      if (this.closed) return;
      const page = this.tasks.listBoards({
        limit: 100,
        ...(after ? { after } : {}),
      });
      for (const board of page.items) {
        if (this.closed) return;
        if (board.dispatchMode !== "auto") continue;
        this.scheduling.add(board.id);
        try {
          await this.scheduleBoard(board.id);
        } finally {
          this.scheduling.delete(board.id);
        }
      }
      after = page.nextCursor;
      await yieldTurn();
    } while (after);
  }
  private async scheduleBoard(boardId: string): Promise<void> {
    const candidates: Task[] = [];
    let after: string | undefined;
    do {
      if (!this.accepting(boardId)) return;
      const page = this.tasks.listTasks(boardId, {
        limit: 100,
        ...(after ? { after } : {}),
      });
      candidates.push(
        ...page.items.filter(
          (task) =>
            (task.status === "ready" || task.status === "triage") &&
            task.assignee !== null &&
            !task.routineOccurrenceId,
        ),
      );
      after = page.nextCursor;
      await yieldTurn();
    } while (after);
    candidates.sort(
      (a, b) =>
        a.priority - b.priority ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
    for (const task of candidates) {
      if (!this.accepting(boardId)) return;
      try {
        this.runner[task.status === "triage" ? "decompose" : "dispatch"](
          task.id,
          {
            expectedRevision: task.revision,
            idempotencyKey: `automatic:${task.id}:${task.revision}`,
            automatic: true,
          },
        );
      } catch (error) {
        if (!(
          (error instanceof TaskError || error instanceof RuntimeError) &&
          ["invalid", "not_found", "conflict"].includes(error.code)
        ))
          throw error;
      }
      await yieldTurn();
    }
  }
  private accepting(boardId: string): boolean {
    if (this.closed || this.fault) return false;
    const board = this.tasks.getBoard(boardId);
    return !board.archived && board.dispatchMode === "auto";
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
