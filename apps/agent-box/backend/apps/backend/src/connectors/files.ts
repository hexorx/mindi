import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { MessagingStore } from "@mindi/messaging";
import { AttachmentStore, MAX_ATTACHMENT_BYTES } from "../attachments.js";
import { ConnectorStore } from "./store.js";
import {
  ConnectorError,
  type ConnectorBinding,
  type ConnectorEvent,
} from "./types.js";
import { id } from "./validation.js";
/** No network or filesystem paths: receiver-owned acquisition supplies bounded bytes. */
export function stageConnectorFile(options: {
  attachments: AttachmentStore;
  messaging: MessagingStore;
  store: ConnectorStore;
  binding: ConnectorBinding;
  event: Pick<
    ConnectorEvent,
    | "provider"
    | "accountId"
    | "credentialGeneration"
    | "chatId"
    | "conversationId"
    | "messageId"
    | "userId"
  >;
  file: { id: string; name: string; bytes: Uint8Array };
}): string {
  const { attachments, messaging, store, binding, event, file } = options;
  const current = store.getBinding(binding.id),
    account = store.getAccount(binding.provider, binding.accountId);
  if (
    !current.enabled ||
    !isDeepStrictEqual(current, binding) ||
    account.credentialGeneration !== binding.credentialGeneration ||
    event.provider !== binding.provider ||
    event.accountId !== binding.accountId ||
    event.credentialGeneration !== binding.credentialGeneration ||
    event.chatId !== binding.chatId ||
    event.conversationId !== binding.conversationId ||
    !binding.allowedUserIds.includes(event.userId)
  )
    throw new ConnectorError(
      "unauthorized",
      "External file admission authority changed",
    );
  if (
    !(file.bytes instanceof Uint8Array) ||
    file.bytes.byteLength > MAX_ATTACHMENT_BYTES
  )
    throw new ConnectorError(
      "invalid",
      "External file exceeds native byte limit",
    );
  const fileId = id(file.id),
    messageId = id(event.messageId);
  const provenance = {
    bindingId: binding.id,
    bindingRevision: binding.revision,
    provider: event.provider,
    accountId: event.accountId,
    chatId: event.chatId,
    conversationId: event.conversationId,
    userId: event.userId,
    messageId,
  };
  messaging.bindExternalConversation({
    bindingId: binding.id,
    bindingRevision: binding.revision,
    provider: binding.provider,
    accountId: binding.accountId,
    chatId: binding.chatId,
    conversationId: binding.conversationId,
    channelId: binding.channelId,
    profileId: binding.profileId,
    allowedUserIds: [...binding.allowedUserIds],
  });
  const idempotencyKey = createHash("sha256")
    .update(
      JSON.stringify([
        binding.id,
        binding.revision,
        event.provider,
        event.accountId,
        event.chatId,
        messageId,
        fileId,
      ]),
    )
    .digest("hex");
  return attachments.stageExternal({
    scope: {
      kind: "channel",
      channelId: binding.channelId,
      profileId: binding.profileId,
    },
    provenance,
    name: file.name,
    data: Buffer.from(file.bytes).toString("base64"),
    idempotencyKey,
  }).id;
}
