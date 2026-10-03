import {
  RuntimeError,
  type AgentRuntime,
  type Run,
} from "@mindi/agent-runtime";
import {
  TaskError,
  type TaskStore,
  type Task,
  type Attempt,
} from "@mindi/tasks";
function inputObject(value: unknown, keys: string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !("value" in Object.getOwnPropertyDescriptor(value, key)!),
    )
  )
    throw new TaskError("invalid", "Invalid task operation input");
}
export class TaskRunner {
  private readonly runtime: AgentRuntime;
  private readonly tasks: TaskStore;
  private readonly leaseMs: number;
  private readonly maxConcurrent: number;
  private closed = false;
  private shutdown?: Promise<void>;
  private readonly active = new Map<
    string,
    { runId: string; done: Promise<Attempt> }
  >();
  constructor(options: {
    runtime: AgentRuntime;
    tasks: TaskStore;
    leaseMs?: number;
    maxConcurrent?: number;
  }) {
    this.runtime = options.runtime;
    this.tasks = options.tasks;
    this.leaseMs = options.leaseMs ?? 30000;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    if (
      !Number.isSafeInteger(this.leaseMs) ||
      this.leaseMs < 100 ||
      this.leaseMs > 86400000 ||
      !Number.isSafeInteger(this.maxConcurrent) ||
      this.maxConcurrent < 1 ||
      this.maxConcurrent > 16
    )
      throw new TaskError("invalid", "Invalid task runner limits");
    for (const attempt of this.unsettled()) {
      if (attempt.runId) {
        try {
          const run = this.runtime.getRun(attempt.runId);
          if (this.settle(attempt, run)) continue;
        } catch {
          /* Missing or unavailable native state remains uncertain. */
        }
      }
      this.tasks.markAttention(
        attempt.id,
        "Native task execution requires reconciliation after restart",
      );
    }
  }
  private *unsettled(): Generator<Attempt> {
    let after: string | undefined;
    do {
      const page = this.tasks.listUnsettledAttempts({
        ...(after ? { after } : {}),
        limit: 100,
      });
      yield* page.items;
      after = page.nextCursor;
    } while (after);
  }
  private abortRun(id: string): void {
    try {
      this.runtime.cancelRun(id);
    } catch {
      this.closed = true;
    }
  }
  private open() {
    if (this.closed)
      throw new TaskError(
        "closed",
        "Task runner is closed or requires recovery",
      );
  }
  private prompt(
    snapshot: Task,
    purpose?: "decompose",
    retryOf?: string,
  ): string {
    const text = [
      purpose === "decompose"
        ? `Decompose this triage task into at most 10 actionable child tasks. Board ID: ${snapshot.boardId}. Parent task ID: ${snapshot.id}. Use kanban_get and kanban_list to inspect existing children before creating any. Use kanban_create with this exact boardId and parentId, stable idempotency keys, clear acceptance contracts, and suitable assignees. Use kanban_update for explicit dependencies separately from parent links; a parent link is not a dependency. Use kanban_prepare only for children that are ready for implementation. Do not execute implementation, alter the parent status, or claim implementation completion. Call task_result exactly once as your final tool with outcome review when the plan is prepared, or blocked with a reason. Planning completion leaves the parent todo for further work.`
        : "Execute this assigned task. Call task_result exactly once as your final tool, with outcome review when ready for independent review, or blocked with the reason. Do not claim operator acceptance.",
      `Title: ${snapshot.title}`,
      `Task: ${snapshot.body}`,
      `Acceptance contract: ${snapshot.completionContract}`,
      ...(retryOf
        ? [
            `This is a retry of attempt ${retryOf}, which completed without calling task_result. Inspect existing work before repeating side effects. You must call task_result exactly once as your final tool; provide outcome review or blocked and an accurate summary.`,
          ]
        : []),
    ].join("\n\n");
    if (Buffer.byteLength(text) > 128 * 1024)
      throw new TaskError(
        "invalid",
        "Task instructions exceed native turn limit",
      );
    return text;
  }
  private admit(task: Task, purpose?: "decompose") {
    this.open();
    const profile = this.runtime.getProfile(task.assignee!);
    if (
      purpose === "decompose" &&
      [
        "kanban_get",
        "kanban_list",
        "kanban_create",
        "kanban_update",
        "kanban_prepare",
      ].some((tool) => !profile.tools.includes(tool))
    )
      throw new TaskError(
        "invalid",
        "Planner profile requires kanban get, list, create, update and prepare grants",
      );
    this.prompt(task, purpose);
    const unsettled = [...this.unsettled()];
    if (Math.max(this.active.size, unsettled.length) >= this.maxConcurrent)
      throw new TaskError("conflict", "Task execution capacity is full");
    if (
      unsettled.some((attempt) => attempt.snapshot.assignee === task.assignee)
    )
      throw new TaskError(
        "conflict",
        "Assignee already has active or uncertain work",
      );
  }
  decompose(
    taskId: string,
    input: {
      expectedRevision: number;
      idempotencyKey: string;
      automatic?: boolean;
    },
  ): Attempt {
    return this.launch(taskId, input, "decompose");
  }
  dispatch(
    taskId: string,
    input: {
      expectedRevision: number;
      idempotencyKey: string;
      automatic?: boolean;
    },
  ): Attempt {
    return this.launch(taskId, input);
  }
  private launch(
    taskId: string,
    input: {
      expectedRevision: number;
      idempotencyKey: string;
      automatic?: boolean;
    },
    purpose?: "decompose",
  ): Attempt {
    this.open();
    inputObject(input, ["expectedRevision", "idempotencyKey", "automatic"]);
    if (
      typeof input.idempotencyKey !== "string" ||
      !input.idempotencyKey.trim()
    )
      throw new TaskError("invalid", "Dispatch idempotency key is required");
    const claim = this.tasks.claim(
      taskId,
      { ...input, leaseMs: this.leaseMs, ...(purpose ? { purpose } : {}) },
      (task) => this.admit(task, purpose),
    );
    let attempt = this.tasks.getAttempt(claim.attempt.id);
    if (attempt.state !== "running" || attempt.runId) return attempt;
    let runId: string | undefined;
    try {
      const thread = this.runtime.createThread({
        profileId: attempt.snapshot.assignee!,
        owner: { kind: "task", id: taskId },
      });
      this.tasks.bindThread(attempt.id, claim.token, thread.id);
      const run = this.runtime.startTurn({
        threadId: thread.id,
        idempotencyKey: attempt.id,
        task: { taskId, attemptId: attempt.id },
        text: this.prompt(attempt.snapshot, attempt.purpose, attempt.retryOf),
      });
      runId = run.id;
      attempt = this.tasks.bindRun(attempt.id, claim.token, run.id);
      const timer = setInterval(
        () => {
          try {
            this.tasks.heartbeat(attempt.id, claim.token, this.leaseMs);
          } catch {
            try {
              this.tasks.requestCancel(attempt.id);
              this.tasks.markAttention(
                attempt.id,
                "Task lease lost; native cancellation requested",
              );
            } catch {
              this.closed = true;
            }
            this.abortRun(run.id);
          }
        },
        Math.max(25, Math.floor(this.leaseMs / 3)),
      );
      const done = Promise.resolve()
        .then(async () => {
          const finished = await this.runtime.waitForRun(run.id);
          const current = this.tasks.getAttempt(attempt.id);
          if (!this.settle(current, finished))
            this.tasks.markAttention(
              attempt.id,
              "Native completion is not proven",
            );
          return this.tasks.getAttempt(attempt.id);
        })
        .catch((error) => {
          this.closed = true;
          try {
            this.tasks.markAttention(
              attempt.id,
              "Task completion storage requires recovery",
            );
          } catch {
            /* Keep durable uncertainty. */
          }
          for (const other of this.active.values()) this.abortRun(other.runId);
          throw error;
        })
        .finally(() => {
          clearInterval(timer);
          this.active.delete(attempt.id);
        });
      this.active.set(attempt.id, { runId: run.id, done });
      void done.catch(() => {});
      return attempt;
    } catch (error) {
      if (runId) this.abortRun(runId);
      try {
        this.tasks.markAttention(
          attempt.id,
          "Task launch requires reconciliation",
        );
      } catch {
        this.closed = true;
      }
      throw error;
    }
  }
  private settle(attempt: Attempt, run: Run): boolean {
    if (
      run.threadId !== attempt.threadId ||
      run.task?.attemptId !== attempt.id ||
      run.task.taskId !== attempt.taskId
    )
      return false;
    if (
      run.state !== "completed" &&
      run.state !== "failed" &&
      run.state !== "cancelled"
    )
      return false;
    const result = attempt.cancellationRequestedAt
      ? {
          outcome: "blocked" as const,
          summary: "Task cancelled; native execution stopped",
        }
      : run.state === "completed" && run.taskOutcome
        ? run.taskOutcome
        : {
            outcome: "blocked" as const,
            summary:
              run.state === "completed"
                ? "Worker ended without a structured task outcome"
                : `Native task run ${run.state}`,
          };
    this.tasks.settleObserved(attempt.id, {
      ...result,
      ...(!attempt.cancellationRequestedAt &&
      run.state === "completed" &&
      !run.taskOutcome
        ? { missingTaskResult: true as const }
        : {}),
      termination: {
        runId: run.id,
        threadId: run.threadId,
        state: run.state,
        ...(run.errorCode ? { errorCode: run.errorCode } : {}),
      },
    });
    return true;
  }
  async wait(attemptId: string): Promise<Attempt> {
    this.tasks.getAttempt(attemptId);
    return this.active.get(attemptId)?.done ?? this.tasks.getAttempt(attemptId);
  }
  cancel(attemptId: string): Attempt {
    this.open();
    let attempt: Attempt;
    try {
      attempt = this.tasks.requestCancel(attemptId);
    } catch (error) {
      if (
        error instanceof TaskError &&
        ["invalid", "not_found", "conflict"].includes(error.code)
      )
        throw error;
      this.closed = true;
      for (const active of this.active.values()) this.abortRun(active.runId);
      throw error;
    }
    const runId = attempt.runId ?? this.findRun(attempt)?.id;
    if (runId) this.abortRun(runId);
    return attempt;
  }
  private findRun(attempt: Attempt): Run | undefined {
    if (attempt.runId) return this.runtime.getRun(attempt.runId);
    return attempt.threadId
      ? this.runtime
          .listRuns(attempt.threadId)
          .find(
            (run) =>
              run.task?.attemptId === attempt.id &&
              run.task.taskId === attempt.taskId,
          )
      : undefined;
  }
  reconcile(
    taskId: string,
    input: {
      expectedRevision: number;
      reason: string;
      confirmStopped?: boolean;
    },
  ): Task {
    this.open();
    inputObject(input, ["expectedRevision", "reason", "confirmStopped"]);
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      typeof input.reason !== "string" ||
      !input.reason.trim() ||
      input.reason.includes("\0") ||
      input.reason.length > 10000 ||
      (input.confirmStopped !== undefined &&
        typeof input.confirmStopped !== "boolean")
    )
      throw new TaskError("invalid", "Invalid reconciliation input");
    const task = this.tasks.getTask(taskId);
    if (
      task.revision !== input.expectedRevision ||
      task.status !== "attention_required"
    )
      throw new TaskError(
        "conflict",
        "Task revision or reconciliation state changed",
      );
    const attempts = [...this.unsettled()].filter(
      (attempt) => attempt.taskId === taskId,
    );
    for (const attempt of attempts) {
      const run = this.findRun(attempt);
      if (run) {
        const ownership = this.runtime.inspectRunOwnership(run.id);
        if (ownership.state === "active")
          throw new TaskError("conflict", "Native task worker is still active");
        if (
          !run.reconciliation &&
          (run.state === "attention_required" || run.state === "interrupted")
        )
          this.runtime.reconcileRun(run.id, {
            reason: input.reason,
            ...(input.confirmStopped !== undefined
              ? { confirmStopped: input.confirmStopped }
              : {}),
          });
      } else if (input.confirmStopped !== true)
        throw new RuntimeError(
          "conflict",
          "Unknown task launch requires confirmation of stopped work",
        );
    }
    return this.tasks.reconcile(taskId, {
      expectedRevision: input.expectedRevision,
      reason: input.reason,
    });
  }
  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closed = true;
    this.shutdown = (async () => {
      let failure: unknown;
      for (const [id, active] of this.active) {
        try {
          this.tasks.requestCancel(id);
        } catch (error) {
          failure ??= error;
        } finally {
          this.abortRun(active.runId);
        }
      }
      await Promise.allSettled(
        [...this.active.values()].map((active) => active.done),
      );
      if (failure) throw failure;
    })();
    return this.shutdown;
  }
}

export { TaskDispatcher, type DispatchStatus } from "./dispatcher.js";
