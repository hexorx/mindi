import type { Delivery, Message, MessagingStore } from "@mindi/messaging";
import { ConnectorAccountOwner } from "./account-owner.js";
import { ConnectorStore } from "./store.js";
import {
  ConnectorError,
  type ConnectorAccountIdentity,
  type ConnectorReplyRecord,
  type ConnectorReplyOperation,
  type ConnectorReplyFile,
  type ConnectorReplyReceipt,
} from "./types.js";

/** Each transport validates identity/destination and returns only verified receipts. */
export interface ConnectorReplyTransport {
  account: ConnectorAccountIdentity;
  verify(reply: ConnectorReplyRecord, signal: AbortSignal): Promise<void>;
  send(
    reply: ConnectorReplyRecord,
    operation: ConnectorReplyOperation,
    signal: AbortSignal,
  ): Promise<ConnectorReplyReceipt>;
  reconcile(
    reply: ConnectorReplyRecord,
    operation: ConnectorReplyOperation,
    signal: AbortSignal,
  ): Promise<ConnectorReplyReceipt | undefined>;
}
export class ConnectorReplyRateLimitUnknown extends Error {
  constructor() {
    super("Provider rate limit requires operator review");
  }
}
/** Only a definitive provider refusal may release a claimed operation for retry. */
export class ConnectorReplyRejected extends Error {
  constructor(readonly retryAfterMs = 0) {
    super("Provider rejected connector reply");
    if (
      !Number.isSafeInteger(retryAfterMs) ||
      retryAfterMs < 0 ||
      retryAfterMs > 86400000
    )
      throw new ConnectorError("invalid", "Invalid provider retry delay");
  }
}
export function planConnectorReply(reply: ConnectorReplyRecord) {
  const limit = reply.binding.provider === "telegram" ? 4096 : 2000;
  const chunks: string[] = [];
  let chunk = "";
  for (const character of reply.text) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff)
      throw new ConnectorError("invalid", "Invalid reply Unicode");
    if (chunk.length + character.length > limit) {
      chunks.push(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) chunks.push(chunk);
  return [
    ...chunks.map((text, index) => ({
      id: `text-${index}`,
      kind: "text" as const,
      text,
    })),
    ...reply.files.map((file, index) => ({
      id: `file-${index}`,
      kind: "file" as const,
      fileId: file.id,
    })),
  ];
}
const activeOwners = new WeakSet<ConnectorAccountOwner>();
/** One account owner serializes both receiver and reply effects. No native runs are started here. */
export class ConnectorReplyDispatcher {
  private active = false;
  private recovered = false;
  private readonly account: ConnectorAccountIdentity;
  constructor(
    private readonly options: {
      store: ConnectorStore;
      messaging: MessagingStore;
      owner: ConnectorAccountOwner;
      transport: ConnectorReplyTransport;
      admitFiles?: (reply: Message, delivery: Delivery) => ConnectorReplyFile[];
    },
  ) {
    const { provider, accountId, credentialGeneration } =
      options.transport.account;
    this.account = Object.freeze({ provider, accountId, credentialGeneration });
    options.owner.assertOwned(this.account);
  }
  private owned(signal: AbortSignal) {
    signal.throwIfAborted();
    this.options.owner.assertOwned(this.account);
  }
  private enqueue() {
    const { store, messaging } = this.options;
    let after: string | undefined;
    while (true) {
      const records = store.pending(after);
      for (const record of records) {
        if (
          record.binding.provider !== this.account.provider ||
          record.binding.accountId !== this.account.accountId ||
          !record.nativeMessageId
        )
          continue;
        const original = messaging.getMessage(record.nativeMessageId);
        const delivery = messaging.getDelivery(original.id);
        if (delivery.state !== "completed") continue;
        const source = original.external;
        if (
          !source ||
          source.bindingId !== record.binding.id ||
          source.bindingRevision !== record.binding.revision ||
          source.provider !== record.event.provider ||
          source.accountId !== record.event.accountId ||
          source.chatId !== record.event.chatId ||
          source.conversationId !== record.event.conversationId ||
          source.messageId !== record.event.messageId ||
          source.userId !== record.event.userId ||
          original.channelId !== record.binding.channelId ||
          original.recipientId !== `agent:${record.binding.profileId}` ||
          original.text !== record.event.text ||
          (original.replyTo ?? null) !==
            (record.event.replyToNativeMessageId ?? null) ||
          JSON.stringify(original.attachmentIds ?? []) !==
            JSON.stringify(record.event.attachmentIds ?? []) ||
          original.branchId ||
          delivery.messageId !== original.id ||
          delivery.channelId !== original.channelId ||
          delivery.profileId !== record.binding.profileId ||
          !delivery.runId ||
          delivery.branchId
        )
          throw new ConnectorError("conflict", "Native reply source mismatch");
        const reply = delivery.replyMessageId
          ? messaging.getMessage(delivery.replyMessageId)
          : undefined;
        if (
          reply &&
          (reply.channelId !== original.channelId ||
            reply.senderId !== `agent:${delivery.profileId}` ||
            reply.recipientId !== original.senderId ||
            reply.replyTo !== original.id ||
            reply.runId !== delivery.runId ||
            reply.text !== delivery.output ||
            reply.branchId)
        )
          throw new ConnectorError("conflict", "Native reply receipt mismatch");
        if (!reply && delivery.output)
          throw new ConnectorError("conflict", "Missing native reply receipt");
        if (
          (reply?.outputs?.length || reply?.conversationOutputs?.length) &&
          !this.options.admitFiles
        )
          throw new ConnectorError(
            "unavailable",
            "Conversation file admission is unavailable",
          );
        const files =
          reply && this.options.admitFiles
            ? this.options.admitFiles(reply, delivery)
            : [];
        store.enqueueReply(record.id, {
          nativeMessageId: original.id,
          nativeDeliveryId: delivery.id,
          runId: delivery.runId,
          ...(reply ? { replyMessageId: reply.id } : {}),
          text: reply?.text ?? "",
          files,
        });
      }
      if (records.length < 100) break;
      after = records.at(-1)!.id;
    }
  }
  async tick(signal: AbortSignal): Promise<void> {
    if (this.active || activeOwners.has(this.options.owner))
      throw new ConnectorError(
        "conflict",
        "Reply dispatcher is already active",
      );
    this.active = true;
    activeOwners.add(this.options.owner);
    try {
      this.owned(signal);
      if (!this.recovered) {
        this.options.store.recoverReplies(this.account);
        this.recovered = true;
      }
      this.enqueue();
      const { store, transport } = this.options;
      let after: string | undefined;
      while (true) {
        const records = store.listReplies({ after, limit: 100 });
        for (const saved of records) {
          if (
            store.getAccount(this.account.provider, this.account.accountId)
              .replyRetryBlocked ||
            (store.getAccount(this.account.provider, this.account.accountId)
              .replyRetryNotBefore ?? 0) > Date.now()
          )
            return;
          if (
            saved.binding.provider !== this.account.provider ||
            saved.binding.accountId !== this.account.accountId
          )
            continue;
          this.owned(signal);
          if ((saved.retryNotBefore ?? 0) > Date.now()) continue;
          const reply = store.planReply(saved.id, planConnectorReply(saved));
          if (
            !reply.operations.length ||
            reply.operations.every((part) => part.state === "confirmed")
          ) {
            store.completeReply(reply.id);
            continue;
          }
          if (
            !store.replyAuthorized(reply.id, this.account) &&
            !reply.operations.some((part) => part.state === "uncertain")
          )
            continue;
          try {
            await transport.verify(reply, signal);
          } catch (error) {
            if (error instanceof ConnectorReplyRateLimitUnknown)
              store.pauseReplyAccount(reply.id);
            if (error instanceof ConnectorReplyRejected)
              store.deferReply(reply.id, error.retryAfterMs);
            this.owned(signal);
            continue;
          }
          this.owned(signal);
          for (const part of reply.operations) {
            if (part.state === "confirmed") continue;
            if (part.state === "uncertain") {
              let receipt: ConnectorReplyReceipt | undefined;
              try {
                receipt = await transport.reconcile(reply, part, signal);
              } catch (error) {
                if (error instanceof ConnectorReplyRateLimitUnknown)
                  store.pauseReplyAccount(reply.id);
                if (error instanceof ConnectorReplyRejected)
                  store.deferReply(reply.id, error.retryAfterMs);
                this.owned(signal);
                break;
              }
              this.owned(signal);
              if (!receipt) break;
              store.confirmReplyOperation(reply.id, part.id, receipt);
              continue;
            }
            if (!store.replyAuthorized(reply.id, this.account)) break;
            this.owned(signal);
            store.beginReplyOperation(reply.id, part.id, this.account);
            try {
              const receipt = await transport.send(reply, part, signal);
              // Receipt persistence remains valid after revocation; it cannot authorize another effect.
              this.options.owner.assertOwned(this.account);
              store.confirmReplyOperation(reply.id, part.id, receipt);
            } catch (error) {
              if (error instanceof ConnectorReplyRateLimitUnknown)
                store.pauseReplyAccount(reply.id);
              if (error instanceof ConnectorReplyRejected)
                store.rejectReplyOperation(
                  reply.id,
                  part.id,
                  error.retryAfterMs,
                );
              else store.markReplyUncertain(reply.id, part.id);
              this.owned(signal);
              break;
            }
          }
          if (
            store
              .getReply(reply.id)
              .operations.every((part) => part.state === "confirmed")
          )
            store.completeReply(reply.id);
        }
        if (records.length < 100) break;
        after = records.at(-1)!.id;
      }
    } finally {
      this.active = false;
      activeOwners.delete(this.options.owner);
    }
  }
}
