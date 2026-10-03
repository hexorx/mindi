import { TaskError, type TaskStore } from "@mindi/tasks";
import { RuntimeError } from "@mindi/agent-runtime";
import type { TaskRunner } from "@mindi/task-runner";
import type { RoutineStore } from "./store.js";
import { setImmediate as yieldTurn } from "node:timers/promises";

export class RoutineScheduler {
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private fault = false;
  constructor(
    private readonly options: {
      routines: RoutineStore;
      tasks: TaskStore;
      runner: TaskRunner;
    },
  ) {}
  status() {
    return {
      phase: this.closed
        ? "stopped"
        : this.fault
          ? "attention_required"
          : this.active
            ? "scheduling"
            : "idle",
      ...(this.fault
        ? { fault: "Routine scheduling requires operator attention" }
        : {}),
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
    }, 1000);
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
        this.fault = true;
        clearInterval(this.timer);
        this.timer = undefined;
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
  private async sweep(): Promise<void> {
    const { routines, tasks, runner } = this.options;
    routines.enqueueDue();
    let after: string | undefined;
    do {
      if (this.closed) return;
      const page = routines.listOpenOccurrences({
        ...(after ? { after } : {}),
        limit: 50,
      });
      for (let occurrence of page.items) {
        if (this.closed) return;
        try {
          if (!occurrence.taskId) {
            const existing = tasks.findRoutineTask(occurrence.id);
            if (existing)
              occurrence = routines.bindTask(occurrence.id, existing.id);
          }
          if (occurrence.taskId && !occurrence.attemptId) {
            const existing = tasks.listAttempts(occurrence.taskId, { limit: 1 })
              .items[0];
            if (existing)
              occurrence = routines.bindAttempt(occurrence.id, existing.id);
          }
          const current = routines.get(occurrence.routineId);
          if (
            !occurrence.attemptId &&
            (current.deleted ||
              (!current.enabled && occurrence.source === "scheduled"))
          ) {
            if (occurrence.taskId) {
              const queued = tasks.getTask(occurrence.taskId);
              tasks.transitionTask(queued.id, {
                expectedRevision: queued.revision,
                status: "archived",
                reason: "Routine paused or deleted before admission",
              });
            }
            routines.finish(occurrence.id, {
              state: "cancelled",
              summary: "Routine paused or deleted before admission",
            });
            continue;
          }
          let task = occurrence.taskId
            ? tasks.getTask(occurrence.taskId)
            : tasks.createTask({
                boardId: occurrence.snapshot.boardId,
                title: occurrence.snapshot.name,
                body: occurrence.snapshot.prompt,
                assignee: occurrence.snapshot.profileId,
                routineOccurrenceId: occurrence.id,
                completionContract:
                  "Report the routine output in task_result with outcome review, or blocked with the reason.",
                idempotencyKey: `routine:${occurrence.id}`,
              });
          routines.bindTask(occurrence.id, task.id);
          if (
            !occurrence.attemptId &&
            (task.status === "archived" || task.status === "blocked")
          ) {
            routines.finish(occurrence.id, {
              state: task.status === "archived" ? "cancelled" : "blocked",
              summary: `Routine task ${task.status} before admission`,
            });
            continue;
          }
          if (task.status === "todo" && !occurrence.attemptId)
            task = tasks.transitionTask(task.id, {
              expectedRevision: task.revision,
              status: "ready",
              reason: "Routine occurrence prepared",
            });
          let attempt = occurrence.attemptId
            ? tasks.getAttempt(occurrence.attemptId)
            : runner.dispatch(task.id, {
                expectedRevision: task.revision,
                idempotencyKey: `routine:${occurrence.id}`,
              });
          routines.bindAttempt(occurrence.id, attempt.id);
          if (attempt.retry) {
            const previous = attempt;
            const latest = tasks.latestAttempt(task.id)!;
            if (latest.id !== previous.id) {
              if (latest.retryOf !== previous.id) {
                routines.finish(occurrence.id, {
                  state: "attention_required",
                  summary: "Routine retry ownership requires reconciliation",
                });
                continue;
              }
              attempt = latest;
            } else {
              task = tasks.getTask(task.id);
              if (
                task.revision !== previous.retry!.taskRevision ||
                task.status !== previous.retry!.phase
              ) {
                routines.finish(occurrence.id, {
                  state: "attention_required",
                  summary: "Routine retry task changed before admission",
                });
                continue;
              }
              if (
                current.deleted ||
                (!current.enabled && occurrence.source === "scheduled")
              ) {
                tasks.transitionTask(task.id, {
                  expectedRevision: task.revision,
                  status: "archived",
                  reason: "Routine paused or deleted before retry admission",
                });
                routines.finish(occurrence.id, {
                  state: "cancelled",
                  summary: "Routine paused or deleted before retry admission",
                });
                continue;
              }
              const board = tasks.getBoard(task.boardId);
              if (board.dispatchMode !== "auto" || board.archived) continue;
              attempt = runner.dispatch(task.id, {
                expectedRevision: task.revision,
                automatic: true,
                idempotencyKey: `routine:${occurrence.id}:retry:${previous.id}`,
              });
            }
            occurrence = routines.advanceAttempt(occurrence.id, {
              expectedAttemptId: previous.id,
              attemptId: attempt.id,
            });
          }
          if (attempt.retry) continue;
          if (attempt.state === "review" || attempt.state === "blocked")
            routines.finish(occurrence.id, {
              state: attempt.state,
              summary: attempt.summary!,
              ...(attempt.outputs ? { outputs: attempt.outputs } : {}),
            });
          if (attempt.state === "attention_required")
            routines.finish(occurrence.id, {
              state: "attention_required",
              summary: "Native routine execution requires reconciliation",
            });
          if (attempt.state === "reconciled")
            routines.finish(occurrence.id, {
              state: "cancelled",
              summary:
                "Native routine execution reconciled; occurrence not replayed",
            });
        } catch (error) {
          if (
            (error instanceof TaskError || error instanceof RuntimeError) &&
            ["invalid", "not_found"].includes(error.code)
          ) {
            const saved = routines.getOccurrence(occurrence.id);
            const task = saved.taskId
              ? tasks.getTask(saved.taskId)
              : tasks.findRoutineTask(saved.id);
            const attempt = task
              ? tasks.listAttempts(task.id, { limit: 1 }).items[0]
              : undefined;
            if (attempt) {
              routines.bindTask(saved.id, task!.id);
              routines.bindAttempt(saved.id, attempt.id);
              routines.finish(saved.id, {
                state: "attention_required",
                summary: "Routine admission requires reconciliation",
              });
            } else {
              if (task && ["todo", "triage", "ready"].includes(task.status))
                tasks.transitionTask(task.id, {
                  expectedRevision: task.revision,
                  status: "blocked",
                  reason: "Routine target or instructions unavailable",
                });
              routines.finish(saved.id, {
                state: "blocked",
                summary: "Routine target or instructions unavailable",
              });
            }
          } else if (!(error instanceof TaskError && error.code === "conflict"))
            throw error;
        } finally {
          await yieldTurn();
        }
      }
      after = page.nextCursor;
    } while (after);
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
