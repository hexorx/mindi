import { ChannelBranches } from "./channel-branches.js";
export { ChannelBranches, type BranchForkView } from "./channel-branches.js";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import {
  RuntimeError,
  type AgentRuntime,
  type Run,
} from "@mindi/agent-runtime";
import {
  MessagingError,
  type MessagingStore,
  type Delivery,
  type Message,
} from "@mindi/messaging";

export class MessageRunner {
  readonly branches: ChannelBranches;
  private readonly runtime: AgentRuntime;
  private readonly messaging: MessagingStore;
  private readonly externalMessageReady?: (message: Message) => boolean;
  private readonly authorizeExternalMessage?: (message: Message) => boolean;
  private readonly active = new Map<
    string,
    { runId: string; done: Promise<void> }
  >();
  private sweep?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closing?: Promise<void>;
  private stopped = false;
  private fault = false;
  constructor(options: {
    runtime: AgentRuntime;
    messaging: MessagingStore;
    externalMessageReady?: (message: Message) => boolean;
    authorizeExternalMessage?: (message: Message) => boolean;
  }) {
    this.branches = new ChannelBranches(options);
    this.runtime = options.runtime;
    this.messaging = options.messaging;
    this.authorizeExternalMessage = options.authorizeExternalMessage;
    this.externalMessageReady = options.externalMessageReady;
  }
  private lastCompletedSweepAt?: number;
  /** Local loop evidence only; this does not verify external worker access. */
  serviceObservation() {
    return {
      phase: this.stopped
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
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 1000);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  status() {
    return {
      phase: this.fault
        ? "attention_required"
        : this.stopped
          ? "stopped"
          : "running",
      active: this.active.size,
    };
  }
  tick(): Promise<void> {
    if (this.sweep) return this.sweep;
    if (this.stopped || this.fault) return Promise.resolve();
    this.sweep = this.scan()
      .then(() => {
        this.lastCompletedSweepAt = Date.now();
      })
      .catch((error) => {
        this.halt();
        throw error;
      })
      .finally(() => {
        this.sweep = undefined;
      });
    return this.sweep;
  }
  private halt() {
    this.fault = true;
    for (const { runId } of this.active.values()) this.runtime.cancelRun(runId);
  }
  private async scan() {
    await this.branches.recover();
    for (const states of [
      ["running", "attention_required"],
      ["queued"],
    ] as const) {
      let after: string | undefined;
      do {
        const page = this.messaging.listDeliveries({
          states: [...states],
          ...(after ? { after } : {}),
        });
        for (const item of page.items) {
          if (this.stopped || this.fault) return;
          if (this.active.has(item.id)) continue;
          if (item.state === "attention_required") {
            if (item.runId && this.runtime.getRun(item.runId).reconciliation)
              this.messaging.reconcileDelivery(item.id, {
                runId: item.runId,
                reason: "Native process ownership reconciled by operator",
              });
          } else if (item.state === "running") {
            if (!item.runId)
              throw new Error("Delivery missing native identity");
            this.watch(item, this.runtime.getRun(item.runId));
          } else if (this.active.size < 4) this.admit(item);
        }
        after = page.nextCursor ?? undefined;
        if (after) await setImmediate();
      } while (after);
    }
  }
  private admit(item: Delivery) {
    const message = this.messaging.getMessage(item.messageId);
    if (item.threadId) {
      this.assertPersona(item, item.threadId);
      const previous = this.runtime.findRunByRequest(
        item.threadId,
        `message:${item.id}`,
      );
      if (previous) {
        const bound = this.messaging.bindDeliveryRun(item.id, previous.id);
        this.watch(bound, previous);
        return;
      }
    }
    if (message.external && !this.authorizeExternalMessage?.(message)) {
      this.messaging.blockDelivery(
        item.id,
        "External connector authority changed or is unavailable",
      );
      return;
    }
    if (
      message.external &&
      this.externalMessageReady &&
      !this.externalMessageReady(message)
    )
      return;
    const channel = this.messaging.getChannel(item.channelId);
    if (
      !channel.members.includes(message.senderId) ||
      !channel.members.includes(`agent:${item.profileId}`)
    ) {
      this.messaging.blockDelivery(
        item.id,
        "Channel membership changed before delivery",
      );
      return;
    }
    try {
      this.runtime.getProfile(item.profileId);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "not_found") {
        this.messaging.blockDelivery(
          item.id,
          "Recipient profile is unavailable",
        );
        return;
      }
      throw error;
    }
    let conversation = this.messaging.getConversation(
      item.channelId,
      item.profileId,
      item.branchId,
    );
    if (!conversation && item.branchId) return;
    if (!conversation) {
      const key =
        "messaging:" +
        createHash("sha256")
          .update(JSON.stringify([item.channelId, item.profileId]))
          .digest("hex");
      const thread = this.runtime.createThread({
        profileId: item.profileId,
        owner: { kind: "channel", id: item.channelId },
        idempotencyKey: key,
      });
      conversation = this.messaging.bindConversation(
        item.channelId,
        item.profileId,
        thread.id,
      );
    }
    this.assertPersona(item, conversation.threadId);
    this.messaging.bindDeliveryThread(item.id, conversation.threadId);
    if (this.runtime.hasUnreconciledRuns(conversation.threadId)) return;
    let run: Run;
    try {
      run = this.runtime.startConversationTurn(
        {
          threadId: conversation.threadId,
          idempotencyKey: `message:${item.id}`,
          ...(message.attachmentIds?.length
            ? { attachmentIds: [...message.attachmentIds] }
            : {}),
          text: `Message from ${message.senderId} in channel ${message.channelId}.\n\n${message.text}`,
        },
        {
          channelId: item.channelId,
          ...(item.branchId ? { branchId: item.branchId } : {}),
        },
      );
    } catch (error) {
      if (error instanceof RuntimeError && error.code === "conflict") return;
      throw error;
    }
    try {
      const bound = this.messaging.bindDeliveryRun(item.id, run.id);
      this.watch(bound, run);
    } catch (error) {
      this.runtime.cancelRun(run.id);
      throw error;
    }
  }
  private watch(item: Delivery, run: Run) {
    if (item.threadId !== run.threadId)
      throw new Error("Delivery native thread mismatch");
    this.assertPersona(item, run.threadId);
    if (item.cancellationRequestedAt) this.runtime.cancelRun(run.id);
    const done = Promise.resolve()
      .then(async () => {
        const finished = await this.runtime.waitForRun(run.id);
        let after = 0,
          fullLength = 0,
          output = "";
        while (true) {
          const page = this.runtime.events(run.id, after);
          for (const event of page) {
            after = event.sequence;
            if (event.type === "text") {
              fullLength += event.text.length;
              output = (output + event.text).slice(0, 32000);
            }
          }
          if (page.length < 1000) break;
          await setImmediate();
        }
        if (output.length && /[\uD800-\uDBFF]/.test(output.at(-1)!))
          output = output.slice(0, -1);
        this.messaging.finishDelivery(item.id, {
          runId: run.id,
          state:
            finished.state === "completed"
              ? "completed"
              : finished.state === "cancelled"
                ? "cancelled"
                : finished.state === "failed"
                  ? "failed"
                  : "attention_required",
          output,
          outputTruncated: output.length < fullLength,
          ...(finished.state === "completed" && finished.conversationOutputs
            ? { conversationOutputs: finished.conversationOutputs }
            : {}),
          ...(finished.state === "completed"
            ? {}
            : { reason: `Native run ${finished.state}` }),
        });
      })
      .catch((error) => {
        this.halt();
        throw error;
      })
      .finally(() => {
        this.active.delete(item.id);
      });
    this.active.set(item.id, { runId: run.id, done });
    void done.catch(() => {});
  }
  private assertPersona(item: Delivery, threadId: string) {
    if (this.runtime.getThread(threadId).profileId !== item.profileId)
      throw new Error("Conversation persona does not match delivery profile");
  }
  cancel(id: string): Delivery {
    let item = this.messaging.getDelivery(id);
    if (item.state === "queued" && item.threadId) {
      const previous = this.runtime.findRunByRequest(
        item.threadId,
        `message:${item.id}`,
      );
      if (previous) {
        this.assertPersona(item, previous.threadId);
        item = this.messaging.bindDeliveryRun(item.id, previous.id);
        if (!this.active.has(item.id)) this.watch(item, previous);
      }
    }
    const native = item.runId ? this.runtime.getRun(item.runId) : undefined;
    if (
      item.state === "attention_required" ||
      (native &&
        !native.reconciliation &&
        ["interrupted", "attention_required"].includes(native.state))
    )
      throw new MessagingError(
        "conflict",
        "Native ownership requires reconciliation",
      );
    const requested = this.messaging.requestCancelDelivery(id);
    if (requested.state === "running" && requested.runId)
      this.runtime.cancelRun(requested.runId);
    return requested;
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.stopped = true;
      this.branches.stop();
      clearInterval(this.timer);
      this.closing = (async () => {
        await this.sweep?.catch(() => {});
        for (const { runId } of this.active.values())
          this.runtime.cancelRun(runId);
        await Promise.allSettled(
          [...this.active.values()].map((item) => item.done),
        );
      })();
    }
    return this.closing;
  }
}
