import { createHash } from "node:crypto";
import type {
  ExternalProvenance,
  Message,
  MessagingStore,
} from "@mindi/messaging";
import {
  ConnectorError,
  ConnectorStore,
  type ConnectorInboxRecord,
} from "./store.js";
function provenance(record: ConnectorInboxRecord): ExternalProvenance {
  return {
    bindingId: record.binding.id,
    bindingRevision: record.binding.revision,
    provider: record.event.provider,
    accountId: record.event.accountId,
    chatId: record.event.chatId,
    conversationId: record.event.conversationId,
    userId: record.event.userId,
    messageId: record.event.messageId,
  };
}
/** Reconciles native admission. The MessageRunner remains the sole execution owner. */
export class ConnectorDispatcher {
  private readonly store: ConnectorStore;
  private readonly messaging: MessagingStore;
  private readonly canAdmit?: (record: ConnectorInboxRecord) => boolean;
  constructor(options: {
    store: ConnectorStore;
    messaging: MessagingStore;
    canAdmit?: (record: ConnectorInboxRecord) => boolean;
  }) {
    this.store = options.store;
    this.messaging = options.messaging;
    this.canAdmit = options.canAdmit;
  }
  private matches(record: ConnectorInboxRecord, message: Message): boolean {
    const source = provenance(record);
    return (
      !!message.external &&
      (Object.keys(source) as (keyof ExternalProvenance)[]).every(
        (key) => message.external![key] === source[key],
      ) &&
      message.channelId === record.binding.channelId &&
      message.recipientId === `agent:${record.binding.profileId}` &&
      message.text === record.event.text &&
      (message.replyTo ?? null) ===
        (record.event.replyToNativeMessageId ?? null) &&
      JSON.stringify(message.attachmentIds ?? []) ===
        JSON.stringify(record.event.attachmentIds ?? []) &&
      !message.branchId &&
      (!record.nativeMessageId || record.nativeMessageId === message.id)
    );
  }
  /** Rechecked immediately before starting a new native run, including after restart. */
  authorized(message: Message): boolean {
    if (!message.external) return false;
    const source = message.external;
    const inboxId = createHash("sha256")
      .update(
        JSON.stringify([
          source.provider,
          source.accountId,
          ...(source.provider === "telegram" ? [source.chatId] : []),
          source.messageId,
        ]),
      )
      .digest("hex");
    let record: ConnectorInboxRecord;
    try {
      record = this.store.get(inboxId);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "not_found")
        return false;
      throw error;
    }
    return this.matches(record, message) && this.store.authorized(record.id);
  }
  tick(): void {
    let after: string | undefined;
    while (true) {
      const records = this.store.pending(after);
      for (const record of records) {
        const source = provenance(record);
        const prior = record.nativeMessageId
          ? this.messaging.getMessage(record.nativeMessageId)
          : this.messaging.findExternalMessage(source);
        if (prior) {
          if (!this.matches(record, prior))
            throw new ConnectorError(
              "conflict",
              "Native connector receipt mismatch",
            );
          this.store.linkNative(record.id, prior.id);
          const delivery = this.messaging.getDelivery(prior.id);
          if (
            delivery.state === "failed" ||
            delivery.state === "cancelled" ||
            delivery.state === "blocked"
          ) {
            this.store.finishWithoutReply(record.id, {
              nativeMessageId: prior.id,
              state: delivery.state,
              reason: delivery.reason ?? "",
            });
          }
          continue;
        }
        if (!this.store.authorized(record.id)) {
          this.store.revokeUnadmitted(record.id);
          continue;
        }
        if (this.canAdmit && !this.canAdmit(record)) continue;
        this.messaging.bindExternalConversation({
          bindingId: record.binding.id,
          bindingRevision: record.binding.revision,
          provider: record.binding.provider,
          accountId: record.binding.accountId,
          chatId: record.binding.chatId,
          conversationId: record.binding.conversationId,
          channelId: record.binding.channelId,
          profileId: record.binding.profileId,
          allowedUserIds: [...record.binding.allowedUserIds],
        });
        const message = this.messaging.admitExternalMessage({
          provenance: source,
          text: record.event.text,
          ...(record.event.attachmentIds?.length
            ? { attachmentIds: record.event.attachmentIds }
            : {}),
          ...(record.event.replyToNativeMessageId
            ? { replyToNativeMessageId: record.event.replyToNativeMessageId }
            : {}),
        });
        if (!this.matches(record, message))
          throw new ConnectorError(
            "conflict",
            "Native connector admission mismatch",
          );
        this.store.linkNative(record.id, message.id);
      }
      if (records.length < 100) break;
      after = records.at(-1)!.id;
    }
  }
}
