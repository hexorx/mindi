import { taskOutputManifest } from "@mindi/agent-runtime/task-outputs";
import { setImmediate } from "node:timers/promises";
import {
  MessagingError,
  type MessagingStore,
  type PublishRoutineOutput,
} from "@mindi/messaging";
import type { TaskStore } from "@mindi/tasks";
import type { RoutineStore } from "./store.js";
import { RoutineError, type RoutinePublication } from "./types.js";
/** Publishes terminal results without owning or replaying their execution. */
export class RoutinePublisher {
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private fault = false;
  constructor(
    private readonly options: {
      routines: RoutineStore;
      tasks: TaskStore;
      messaging: MessagingStore;
    },
  ) {}
  status() {
    return {
      phase: this.closed
        ? "stopped"
        : this.fault
          ? "attention_required"
          : this.active
            ? "publishing"
            : "idle",
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
  start() {
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
  private async sweep() {
    let after: string | undefined;
    do {
      if (this.closed) return;
      const page = this.options.routines.listPublications({
        states: ["pending"],
        ...(after ? { after } : {}),
      });
      for (const publication of page.items) {
        if (this.closed) return;
        const input = this.output(publication);
        try {
          const message = this.options.messaging.publishRoutineOutput(input);
          this.options.routines.markPublished(publication.id, message.id);
        } catch (error) {
          if (
            error instanceof MessagingError &&
            ["invalid", "not_found"].includes(error.code)
          )
            this.options.routines.blockPublication(
              publication.id,
              "Routine destination or persona is unavailable",
            );
          else throw error;
        }
      }
      after = page.nextCursor;
      if (after) await setImmediate();
    } while (after);
  }
  private output(publication: RoutinePublication): PublishRoutineOutput {
    const occurrence = this.options.routines.getOccurrence(
      publication.occurrenceId,
    );
    if (
      !["review", "blocked", "cancelled"].includes(occurrence.state) ||
      occurrence.summary === undefined ||
      (!occurrence.summary && !occurrence.outputs) ||
      !occurrence.endedAt ||
      occurrence.snapshot.profileId !== publication.profileId ||
      JSON.stringify(occurrence.snapshot.destination) !==
        JSON.stringify(publication.destination)
    )
      throw new RoutineError(
        "conflict",
        "Publication outcome does not match its immutable occurrence",
      );
    const attempt = occurrence.attemptId
      ? this.options.tasks.getAttempt(occurrence.attemptId)
      : undefined;
    if (
      attempt &&
      (attempt.taskId !== occurrence.taskId ||
        attempt.snapshot.routineOccurrenceId !== occurrence.id)
    )
      throw new RoutineError("conflict", "Publication native attempt mismatch");
    let outputs;
    if (occurrence.outputs !== undefined || attempt?.outputs !== undefined) {
      if (
        !attempt ||
        !attempt.threadId ||
        !attempt.runId ||
        attempt.snapshot.assignee !== publication.profileId ||
        attempt.state !== occurrence.state ||
        attempt.summary !== occurrence.summary
      )
        throw new RoutineError(
          "conflict",
          "Publication native output mismatch",
        );
      try {
        const scope = {
          profileId: publication.profileId,
          threadId: attempt.threadId,
          runId: attempt.runId,
          taskId: attempt.taskId,
          attemptId: attempt.id,
        };
        outputs = taskOutputManifest(occurrence.outputs, scope);
        if (
          JSON.stringify(outputs) !==
          JSON.stringify(taskOutputManifest(attempt.outputs, scope))
        )
          throw Error();
      } catch {
        throw new RoutineError(
          "conflict",
          "Publication native output mismatch",
        );
      }
    }
    return {
      ...(outputs ? { outputs, threadId: attempt!.threadId! } : {}),
      channelId: publication.destination.channelId,
      ...(publication.destination.branchId
        ? { branchId: publication.destination.branchId }
        : {}),
      profileId: publication.profileId,
      routineId: occurrence.routineId,
      occurrenceId: occurrence.id,
      state: occurrence.state as PublishRoutineOutput["state"],
      summary: occurrence.summary,
      ...(occurrence.taskId ? { taskId: occurrence.taskId } : {}),
      ...(occurrence.attemptId ? { attemptId: occurrence.attemptId } : {}),
      ...(attempt?.runId ? { runId: attempt.runId } : {}),
    };
  }
  retry(id: string) {
    if (this.closed || this.fault)
      throw new RoutineError(
        "unavailable",
        "Routine publisher requires restart",
      );
    const publication = this.options.routines.retryPublication(id);
    void this.tick();
    return publication;
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
