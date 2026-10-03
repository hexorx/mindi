import type { InboundNormalization } from "./inbound-files.js";
import { createHash } from "node:crypto";
import { telegramId, telegramTopicId } from "../telegram-routine-delivery.js";
import {
  ConnectorError,
  type ConnectorBinding,
  type ConnectorEvent,
} from "./types.js";
import { id } from "./validation.js";
export type TelegramDisposition = { eventId: string; fingerprint: string } & (
  | {
      status: "accepted";
      bindingId: string;
      bindingRevision: number;
      event: ConnectorEvent;
    }
  | {
      status:
        | "unauthorized"
        | "self_or_bot"
        | "unsupported_event"
        | "unsupported_file"
        | "unsupported_context"
        | "content_unavailable";
    }
);
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function invalid(): never {
  throw new ConnectorError("invalid", "Invalid Telegram update");
}
function numericId(value: unknown, positive = false): string | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    telegramId(String(value), positive)
    ? String(value)
    : undefined;
}
/** Stable exact destination; Telegram message deduplication separately uses chatId. */
export function telegramConversationId(
  chatId: string,
  topicId?: string,
): string {
  if (
    !telegramId(chatId) ||
    (topicId !== undefined && !telegramTopicId(topicId))
  )
    invalid();
  return JSON.stringify(["telegram", chatId, topicId ?? null]);
}
function fingerprint(value: unknown): string {
  function canonical(value: unknown, depth: number): unknown {
    if (depth > 32) invalid();
    if (Array.isArray(value))
      return value.map((item) => canonical(item, depth + 1));
    const row = record(value);
    if (row)
      return Object.fromEntries(
        Object.keys(row)
          .sort()
          .map((key) => [key, canonical(row[key], depth + 1)]),
      );
    return value;
  }
  try {
    const text = JSON.stringify(canonical(value, 0));
    if (!text || Buffer.byteLength(text) > 1024 * 1024) invalid();
    return createHash("sha256").update(text).digest("hex");
  } catch {
    invalid();
  }
}
/** No effects. Unsupported input is journaled explicitly, never reduced to a caption. */
export function telegramDisposition(
  input: unknown,
  account: {
    provider: "telegram";
    accountId: string;
    credentialGeneration: string;
  },
  bindings: readonly ConnectorBinding[],
  normalization: InboundNormalization = {},
): TelegramDisposition {
  if (account.provider !== "telegram" || !telegramId(account.accountId, true))
    invalid();
  id(account.credentialGeneration);
  const update = record(input);
  if (
    !update ||
    typeof update.update_id !== "number" ||
    !Number.isSafeInteger(update.update_id) ||
    update.update_id < 0 ||
    update.update_id >= Number.MAX_SAFE_INTEGER
  )
    invalid();
  const base = {
    eventId: String(update.update_id),
    fingerprint: fingerprint(input),
  };
  if (
    Object.keys(update)
      .filter((key) => key !== "update_id")
      .join(",") !== "message"
  )
    return { ...base, status: "unsupported_event" };
  const message = record(update.message),
    chat = record(message?.chat),
    from = record(message?.from);
  const userId = numericId(from?.id, true),
    chatId = numericId(chat?.id),
    messageId = numericId(message?.message_id, true);
  if (
    !message ||
    !chat ||
    !from ||
    !userId ||
    !chatId ||
    !messageId ||
    !telegramTopicId(messageId) ||
    typeof from.is_bot !== "boolean"
  )
    return { ...base, status: "unsupported_context" };
  if (from.is_bot || userId === account.accountId)
    return { ...base, status: "self_or_bot" };
  const unsupported = [
    "sender_chat",
    "sender_business_bot",
    "business_connection_id",
    "guest_query_id",
    "guest_bot_caller_user",
    "guest_bot_caller_chat",
    "ephemeral_message_id",
    "receiver_user",
    "direct_messages_topic",
    "external_reply",
    "quote",
    "rich_message",
  ];
  if (
    unsupported.some((key) => key in message) ||
    typeof chat.type !== "string" ||
    !["private", "group", "supergroup"].includes(chat.type) ||
    chat.is_direct_messages === true ||
    (chat.type === "private" ? chatId !== userId : !chatId.startsWith("-"))
  )
    return { ...base, status: "unsupported_context" };
  const topicId =
    message.message_thread_id === undefined
      ? undefined
      : numericId(message.message_thread_id, true);
  if (
    message.message_thread_id !== undefined &&
    (!topicId || !telegramTopicId(topicId) || chat.type === "group")
  )
    return { ...base, status: "unsupported_context" };
  const conversationId = telegramConversationId(chatId, topicId);
  const candidates = bindings.filter(
    (binding) =>
      binding.enabled &&
      binding.provider === "telegram" &&
      binding.accountId === account.accountId &&
      binding.credentialGeneration === account.credentialGeneration &&
      binding.chatId === chatId &&
      binding.conversationId === conversationId &&
      binding.allowedUserIds.includes(userId),
  );
  if (candidates.length !== 1) return { ...base, status: "unauthorized" };
  let replyToNativeMessageId: string | undefined;
  if (message.reply_to_message !== undefined) {
    const reference = record(message.reply_to_message);
    const referenceId = numericId(reference?.message_id, true);
    if (
      !referenceId ||
      !telegramTopicId(referenceId) ||
      numericId(record(reference?.chat)?.id) !== chatId
    )
      return { ...base, status: "unsupported_context" };
    replyToNativeMessageId = normalization.resolveReplyReference?.({
      provider: "telegram",
      accountId: account.accountId,
      chatId,
      conversationId,
      messageId: referenceId,
    })?.nativeMessageId;
    if (!replyToNativeMessageId)
      return { ...base, status: "unsupported_context" };
  }
  const files = [
    "photo",
    "document",
    "audio",
    "video",
    "voice",
    "video_note",
    "animation",
    "sticker",
    "paid_media",
    "live_photo",
  ];
  const hasFiles = files.some((key) => key in message);
  if (hasFiles && normalization.attachmentIds === undefined)
    return { ...base, status: "unsupported_file" };
  if (message.text !== undefined && message.caption !== undefined)
    return { ...base, status: "unsupported_context" };
  const text = message.text ?? (hasFiles ? (message.caption ?? "") : undefined);
  if (
    typeof text !== "string" ||
    (!text.trim() && !hasFiles) ||
    text.length > 32000 ||
    text.includes("\0")
  )
    return { ...base, status: "content_unavailable" };
  const binding = candidates[0]!;
  return {
    ...base,
    status: "accepted",
    bindingId: binding.id,
    bindingRevision: binding.revision,
    event: {
      provider: "telegram",
      accountId: account.accountId,
      credentialGeneration: account.credentialGeneration,
      eventId: base.eventId,
      messageId,
      chatId,
      conversationId,
      userId,
      text,
      ...(hasFiles && normalization.attachmentIds?.length
        ? { attachmentIds: [...normalization.attachmentIds] }
        : {}),
      ...(replyToNativeMessageId ? { replyToNativeMessageId } : {}),
    },
  };
}
