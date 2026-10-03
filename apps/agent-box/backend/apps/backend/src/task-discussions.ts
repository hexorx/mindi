import type { TaskStore } from "@mindi/tasks";
import type { MessagingStore } from "@mindi/messaging";

/** Recovers the TaskStore-to-channel projection without owning comment bodies. */
export class TaskDiscussionPublisher {
  private readonly tasks: TaskStore;
  private readonly messaging: MessagingStore;
  private readonly batchSize: number;
  private readonly intervalMs: number;
  private cursor?: string;
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private lastCompletedSweepAt?: number;
  private failed = false;
  private sweepFailed = false;

  constructor(options: {
    tasks: TaskStore;
    messaging: MessagingStore;
    batchSize?: number;
    intervalMs?: number;
  }) {
    this.tasks = options.tasks;
    this.messaging = options.messaging;
    this.batchSize = options.batchSize ?? 50;
    this.intervalMs = options.intervalMs ?? 1000;
    if (
      !Number.isSafeInteger(this.batchSize) ||
      this.batchSize < 1 ||
      this.batchSize > 100 ||
      !Number.isSafeInteger(this.intervalMs) ||
      this.intervalMs < 100 ||
      this.intervalMs > 60000
    )
      throw Error("Invalid task discussion publisher limits");
  }

  serviceObservation() {
    return {
      phase: this.closed
        ? ("stopped" as const)
        : this.failed
          ? ("attention_required" as const)
          : this.lastCompletedSweepAt === undefined
            ? ("unknown" as const)
            : ("ready" as const),
      lastCompletedSweepAt: this.lastCompletedSweepAt,
    };
  }

  start() {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  tick(): Promise<void> {
    if (this.active) return this.active;
    if (this.closed) return Promise.resolve();
    this.active = Promise.resolve()
      .then(() => {
        let failed = false;
        try {
          const page = this.tasks.listPendingDiscussionAnchors({
            limit: this.batchSize,
            ...(this.cursor ? { after: this.cursor } : {}),
          });
          this.cursor = page.nextCursor;
          for (const discussion of page.items) {
            try {
              const anchor = this.messaging.publishTaskDiscussionAnchor({
                discussionId: discussion.id,
                taskId: discussion.taskId,
                boardId: discussion.boardId,
                channelId: discussion.channelId,
                title: discussion.title,
                createdAt: discussion.createdAt,
              });
              this.tasks.acknowledgeDiscussionAnchor(discussion.id, {
                channelId: discussion.channelId,
                messageId: anchor.id,
              });
            } catch {
              failed = true;
            }
          }
          this.sweepFailed ||= failed;
          if (!this.cursor) {
            this.lastCompletedSweepAt = Date.now();
            this.failed = this.sweepFailed;
            this.sweepFailed = false;
          } else if (failed) {
            this.failed = true;
          }
        } catch {
          this.failed = true;
          this.sweepFailed = false;
          this.cursor = undefined;
        }
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }

  async close() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.active;
  }
}
