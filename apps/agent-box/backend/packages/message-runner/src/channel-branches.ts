import { setImmediate } from "node:timers/promises";
import {
  RuntimeError,
  type AgentRuntime,
  type ForkOperation,
} from "@mindi/agent-runtime";
import {
  MessagingError,
  type MessagingStore,
  type BranchFork,
  type Message,
} from "@mindi/messaging";

export type BranchForkView = BranchFork & { operation?: ForkOperation };
/** Coordinates checkpoint receipts across the runtime and messaging databases. */
export class ChannelBranches {
  private stopped = false;
  private readonly pending = new Set<Promise<BranchForkView>>();
  constructor(
    private readonly options: {
      runtime: AgentRuntime;
      messaging: MessagingStore;
    },
  ) {}
  private provenance(
    channelId: string,
    parentMessageId: string,
    profileId: string,
    parentBranchId?: string,
  ) {
    const { messaging, runtime } = this.options;
    const message = messaging.getMessage(parentMessageId);
    if (
      message.channelId !== channelId ||
      (message.branchId ?? undefined) !== parentBranchId
    )
      throw new MessagingError(
        "invalid",
        "Reply parent must belong to exact channel branch",
      );
    const delivery = messaging.findReplyDelivery(message.id, profileId);
    const role =
      delivery?.messageId === message.id
        ? ("user" as const)
        : ("assistant" as const);
    if (
      !delivery ||
      delivery.state !== "completed" ||
      !delivery.runId ||
      !delivery.threadId ||
      delivery.channelId !== channelId ||
      delivery.branchId !== parentBranchId ||
      (role === "assistant" &&
        (delivery.replyMessageId !== message.id ||
          message.runId !== delivery.runId ||
          message.senderId !== `agent:${profileId}` ||
          message.truncated ||
          delivery.outputTruncated ||
          delivery.output !== message.text))
    )
      throw new MessagingError(
        "conflict",
        "Selected message has no exact completed delivery provenance",
      );
    const run = runtime.getRun(delivery.runId);
    if (
      run.state !== "completed" ||
      run.threadId !== delivery.threadId ||
      !run.userEntryId ||
      messaging.getConversation(channelId, profileId, parentBranchId)
        ?.threadId !== run.threadId
    )
      throw new MessagingError(
        "conflict",
        "Selected message has no exact completed native entry",
      );
    return { message, run, role };
  }
  /** Read-only hint; reply admission still revalidates the completed checkpoint. */
  projectMessage(message: Message) {
    for (const member of new Set([message.senderId, message.recipientId])) {
      if (!member?.startsWith("agent:")) continue;
      const profileId = member.slice(6);
      try {
        this.provenance(
          message.channelId,
          message.id,
          profileId,
          message.branchId,
        );
        return { ...message, replyProfileId: profileId };
      } catch (error) {
        if (
          !(error instanceof MessagingError || error instanceof RuntimeError) ||
          !["invalid", "conflict", "not_found"].includes(error.code)
        )
          throw error;
      }
    }
    return { ...message };
  }
  async reply(input: {
    channelId: string;
    parentMessageId: string;
    profileId: string;
    parentBranchId?: string;
    idempotencyKey: string;
  }) {
    if (this.stopped)
      throw new MessagingError("unavailable", "Channel branch service stopped");
    if (!input.idempotencyKey || typeof input.idempotencyKey !== "string")
      throw new MessagingError("invalid", "Reply identity required");
    const source = this.provenance(
      input.channelId,
      input.parentMessageId,
      input.profileId,
      input.parentBranchId,
    );
    const branch = this.options.messaging.createBranch({
      channelId: input.channelId,
      name: `Reply · ${input.profileId}`,
      parentMessageId: input.parentMessageId,
      ...(input.parentBranchId ? { parentBranchId: input.parentBranchId } : {}),
      idempotencyKey: input.idempotencyKey,
    });
    const fork = await this.fork({
      branchId: branch.id,
      profileId: input.profileId,
      entryId: source.run.userEntryId!,
      replyToRunId: source.run.id,
      replyToRole: source.role,
      idempotencyKey: input.idempotencyKey,
    });
    return { branch, parentMessage: this.projectMessage(source.message), fork };
  }
  threads(
    channelId: string,
    input: { branchId?: string; after?: string; limit?: number } = {},
  ) {
    const { messaging } = this.options;
    const page = messaging.listChildBranches(channelId, input);
    return {
      ...page,
      items: page.items.map((branch) => {
        const forks: BranchForkView[] = [];
        let after: string | undefined;
        do {
          const page = messaging.listBranchForks(branch.id, {
            ...(after ? { after } : {}),
          });
          forks.push(...page.items.map((item) => this.getFork(item.id)));
          after = page.nextCursor ?? undefined;
        } while (after);
        return {
          branch,
          ...(branch.parentMessageId
            ? {
                parentMessage: this.projectMessage(
                  messaging.getMessage(branch.parentMessageId),
                ),
              }
            : {}),
          ...messaging.branchMessageSummary(branch.id),
          forks,
        };
      }),
    };
  }
  points(channelId: string, profileId: string, branchId?: string) {
    if (this.stopped)
      throw new MessagingError("unavailable", "Channel branch service stopped");
    const conversation = this.options.messaging.getConversation(
      channelId,
      profileId,
      branchId,
    );
    if (!conversation)
      throw new MessagingError(
        "conflict",
        "Conversation has no native mapping",
      );
    if (
      this.options.runtime.getThread(conversation.threadId).profileId !==
      profileId
    )
      throw new MessagingError("conflict", "Conversation persona mismatch");
    return this.options.runtime.branchPoints(conversation.threadId);
  }
  private key(request: BranchFork) {
    return `channel-fork:${request.id}`;
  }
  getFork(id: string): BranchForkView {
    const request = this.options.messaging.getBranchFork(id);
    const operation = this.options.runtime.findForkByRequest(this.key(request));
    if (operation) this.assertOperation(request, operation);
    return { ...request, ...(operation ? { operation } : {}) };
  }
  private assertOperation(request: BranchFork, operation: ForkOperation) {
    if (
      operation.parentThreadId !== request.parentThreadId ||
      operation.entryId !== request.entryId ||
      operation.replyToRunId !== request.replyToRunId ||
      (operation.replyToRole ?? "assistant") !==
        (request.replyToRole ?? "assistant")
    )
      throw new MessagingError(
        "conflict",
        "Native fork request identity mismatch",
      );
    const parent = this.options.runtime.getThread(request.parentThreadId);
    if (parent.profileId !== request.profileId)
      throw new MessagingError("conflict", "Native fork persona mismatch");
    if (operation.state === "completed") {
      const child = this.options.runtime.getThread(operation.childThreadId);
      if (
        child.profileId !== request.profileId ||
        child.parentId !== parent.id ||
        child.branchEntryId !== request.entryId
      )
        throw new MessagingError(
          "conflict",
          "Native child checkpoint mismatch",
        );
    }
  }
  /** Adopt persisted terminal evidence only; never invokes the native worker. */
  recoverReceipt(id: string): BranchForkView {
    if (this.stopped)
      throw new MessagingError("unavailable", "Channel branch service stopped");
    return this.adopt(this.options.messaging.getBranchFork(id));
  }
  private adopt(request: BranchFork): BranchForkView {
    const view = this.getFork(request.id),
      operation = view.operation;
    if (request.state === "pending" && operation) {
      if (operation.state === "completed")
        this.options.messaging.completeBranchFork(request.id, {
          forkOperationId: operation.id,
          threadId: operation.childThreadId,
        });
      else if (operation.state === "cancelled")
        this.options.messaging.cancelBranchFork(request.id, {
          forkOperationId: operation.id,
          reason: operation.reconciliation?.reason ?? "Native fork abandoned",
        });
    }
    return this.getFork(request.id);
  }
  fork(input: {
    replyToRunId?: string;
    replyToRole?: "user" | "assistant";
    branchId: string;
    profileId: string;
    entryId: string;
    idempotencyKey: string;
  }): Promise<BranchForkView> {
    if (this.stopped)
      throw new MessagingError("unavailable", "Channel branch service stopped");
    const operation = this.execute(input);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  private async execute(input: {
    replyToRunId?: string;
    replyToRole?: "user" | "assistant";
    branchId: string;
    profileId: string;
    entryId: string;
    idempotencyKey: string;
  }): Promise<BranchForkView> {
    const { messaging, runtime } = this.options;
    const branch = messaging.getBranch(input.branchId);
    if (branch.parentMessageId) {
      const source = this.provenance(
        branch.channelId,
        branch.parentMessageId,
        input.profileId,
        branch.parentBranchId ?? undefined,
      );
      if (
        input.replyToRunId !== source.run.id ||
        input.entryId !== source.run.userEntryId ||
        input.replyToRole !== source.role
      )
        throw new MessagingError("conflict", "Reply provenance mismatch");
    } else if (input.replyToRunId !== undefined)
      throw new MessagingError(
        "invalid",
        "Reply requires anchored channel branch",
      );
    const parent = messaging.getConversation(
      branch.channelId,
      input.profileId,
      branch.parentBranchId ?? undefined,
    );
    if (!parent)
      throw new MessagingError(
        "conflict",
        "Parent conversation has no native checkpoint mapping",
      );
    if (runtime.getThread(parent.threadId).profileId !== input.profileId)
      throw new MessagingError(
        "conflict",
        "Parent conversation persona mismatch",
      );
    const request = messaging.beginBranchFork({
      ...input,
      parentThreadId: parent.threadId,
    });
    return this.admit(request);
  }
  /** Explicit operator retry of the stored checkpoint, never a replacement identity. */
  retryReceipt(id: string): Promise<BranchForkView> {
    if (this.stopped)
      throw new MessagingError("unavailable", "Channel branch service stopped");
    const operation = this.admit(this.options.messaging.getBranchFork(id));
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  private async admit(request: BranchFork): Promise<BranchForkView> {
    const { messaging, runtime } = this.options;
    const view = this.adopt(request);
    if (view.state !== "pending" || view.operation) return view;
    const branch = messaging.getBranch(request.branchId);
    const parent = messaging.getConversation(
      branch.channelId,
      request.profileId,
      branch.parentBranchId ?? undefined,
    );
    if (
      parent?.threadId !== request.parentThreadId ||
      runtime.getThread(request.parentThreadId).profileId !== request.profileId
    )
      throw new MessagingError(
        "conflict",
        "Stored fork parent mapping changed",
      );
    if (
      !messaging
        .getChannel(branch.channelId)
        .members.includes(`agent:${request.profileId}`)
    )
      throw new MessagingError(
        "conflict",
        "Channel membership changed before fork admission",
      );
    runtime.getProfile(request.profileId);
    try {
      await runtime.forkThread({
        ...(request.replyToRunId
          ? {
              replyToRunId: request.replyToRunId,
              replyToRole: request.replyToRole ?? "assistant",
            }
          : {}),
        threadId: request.parentThreadId,
        entryId: request.entryId,
        idempotencyKey: this.key(request),
      });
    } catch (error) {
      // A persisted native attempt remains inspectable, including lost results.
      if (runtime.findForkByRequest(this.key(request)))
        return this.adopt(request);
      if (error instanceof RuntimeError) throw error;
      throw new MessagingError(
        "unavailable",
        "Native branch creation unavailable",
      );
    }
    return this.adopt(request);
  }
  async recover(): Promise<void> {
    let after: string | undefined;
    do {
      if (this.stopped) return;
      const page = this.options.messaging.listBranchForks(undefined, {
        ...(after ? { after } : {}),
      });
      for (const request of page.items)
        if (request.state === "pending") this.adopt(request);
      after = page.nextCursor ?? undefined;
      if (after) await setImmediate();
    } while (after);
  }
  stop() {
    this.stopped = true;
  }
  async drain() {
    await Promise.allSettled([...this.pending]);
  }
}
