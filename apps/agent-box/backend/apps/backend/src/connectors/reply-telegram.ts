import { telegramId, telegramTopicId } from "../telegram-routine-delivery.js";
import {
  ConnectorReplyRejected,
  ConnectorReplyRateLimitUnknown,
  type ConnectorReplyTransport,
} from "./replies.js";
import type {
  ConnectorAccountIdentity,
  ConnectorReplyOperation,
  ConnectorReplyRecord,
  ConnectorReplyReceipt,
} from "./types.js";
import {
  replyFile,
  replyObject,
  replyRequest,
  replyScope,
  unknownReply,
  type ConnectorReplyFileReader,
} from "./reply-transport-io.js";
/** Bot API reply transport. Uncertain sends deliberately have no resend path. */
export function createTelegramReplyTransport(options: {
  account: ConnectorAccountIdentity;
  token: string;
  request?: typeof fetch;
  readFile?: ConnectorReplyFileReader;
  assertAuthorized: (reply: ConnectorReplyRecord) => void;
}): ConnectorReplyTransport {
  const { provider, accountId, credentialGeneration } = options.account;
  const account = Object.freeze({ provider, accountId, credentialGeneration });
  const token = options.token,
    request = options.request ?? fetch;
  if (
    provider !== "telegram" ||
    !telegramId(accountId, true) ||
    !/^\d+:[A-Za-z0-9_-]+$/.test(token) ||
    token.length > 16384
  )
    throw unknownReply();
  function destination(
    reply: ConnectorReplyRecord,
    op?: ConnectorReplyOperation,
  ) {
    replyScope(reply, account, op);
    let parts: unknown;
    try {
      parts = JSON.parse(reply.binding.conversationId);
    } catch {
      throw unknownReply();
    }
    if (
      !Array.isArray(parts) ||
      parts.length !== 3 ||
      parts[0] !== "telegram" ||
      parts[1] !== reply.binding.chatId ||
      !telegramId(parts[1]) ||
      (parts[2] !== null && !telegramTopicId(parts[2])) ||
      JSON.stringify(parts) !== reply.binding.conversationId ||
      !telegramTopicId(reply.event.messageId)
    )
      throw unknownReply();
    return { chatId: parts[1] as string, topicId: parts[2] as string | null };
  }
  async function api(
    method: string,
    body: Record<string, unknown> | FormData,
    signal: AbortSignal,
  ) {
    const multipart = body instanceof FormData;
    const response = await replyRequest(
      request,
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        ...(multipart
          ? { body }
          : {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
      signal,
    );
    if (response.status === 429) {
      let delay: unknown;
      try {
        delay = replyObject(replyObject(response.value).parameters).retry_after;
      } catch {
        throw new ConnectorReplyRateLimitUnknown();
      }
      if (
        typeof delay !== "number" ||
        !Number.isSafeInteger(delay) ||
        delay < 0 ||
        delay > 86400
      )
        throw new ConnectorReplyRateLimitUnknown();
      throw new ConnectorReplyRejected(delay * 1000);
    }
    const value = replyObject(response.value);
    if (!response.ok || value.ok !== true) {
      if (
        value.ok === false &&
        [400, 401, 403, 404, 409, 413].includes(response.status) &&
        value.error_code === response.status
      )
        throw new ConnectorReplyRejected(5000);
      throw unknownReply();
    }
    return replyObject(value.result);
  }
  function receipt(
    reply: ConnectorReplyRecord,
    op: ConnectorReplyOperation,
    message: Record<string, unknown>,
  ): ConnectorReplyReceipt {
    const target = destination(reply, op),
      chat = replyObject(message.chat),
      from = replyObject(message.from),
      ref = replyObject(message.reply_to_message);
    if (
      !Number.isSafeInteger(message.message_id) ||
      !telegramTopicId(String(message.message_id)) ||
      chat.id !== Number(target.chatId) ||
      typeof chat.type !== "string" ||
      !["private", "group", "supergroup"].includes(chat.type) ||
      from.id !== Number(accountId) ||
      from.is_bot !== true ||
      (message.message_thread_id ?? null) !==
        (target.topicId === null ? null : Number(target.topicId)) ||
      ref.message_id !== Number(reply.event.messageId) ||
      replyObject(ref.chat).id !== Number(target.chatId) ||
      [
        "photo",
        "audio",
        "video",
        "voice",
        "video_note",
        "animation",
        "sticker",
        "paid_media",
        "live_photo",
        "sender_chat",
        "business_connection_id",
        "sender_business_bot",
        "guest_query_id",
        "ephemeral_message_id",
        "receiver_user",
        "external_reply",
        "forward_origin",
        "rich_message",
      ].some((k) => k in message)
    )
      throw unknownReply();
    if (op.kind === "text") {
      if (
        message.text !== op.text ||
        message.document !== undefined ||
        message.caption !== undefined
      )
        throw unknownReply();
    } else {
      const file = reply.files.find((f) => f.id === op.fileId),
        doc = replyObject(message.document);
      if (
        !file ||
        message.text !== undefined ||
        message.caption !== undefined ||
        doc.file_name !== file.name ||
        doc.file_size !== file.size ||
        doc.mime_type !== file.mediaType ||
        typeof doc.file_id !== "string" ||
        !doc.file_id ||
        typeof doc.file_unique_id !== "string" ||
        !doc.file_unique_id
      )
        throw unknownReply();
    }
    return {
      provider: "telegram",
      accountId,
      chatId: target.chatId,
      conversationId: reply.binding.conversationId,
      messageId: String(message.message_id),
    };
  }
  return {
    account,
    async verify(reply, signal) {
      const target = destination(reply);
      const me = await api("getMe", {}, signal);
      if (me.id !== Number(accountId) || me.is_bot !== true)
        throw unknownReply();
      const chat = await api("getChat", { chat_id: target.chatId }, signal);
      if (
        chat.id !== Number(target.chatId) ||
        typeof chat.type !== "string" ||
        !["private", "group", "supergroup"].includes(chat.type) ||
        (chat.type === "private"
          ? target.chatId !== reply.event.userId
          : !target.chatId.startsWith("-")) ||
        (target.topicId !== null &&
          (chat.type === "group" ||
            (chat.type === "supergroup" && chat.is_forum !== true))) ||
        chat.is_direct_messages === true
      )
        throw unknownReply();
    },
    async send(reply, op, signal) {
      const target = destination(reply, op);
      signal.throwIfAborted();
      const payload: Record<string, unknown> = {
        chat_id: target.chatId,
        ...(target.topicId === null
          ? {}
          : { message_thread_id: Number(target.topicId) }),
        reply_parameters: {
          message_id: Number(reply.event.messageId),
          allow_sending_without_reply: false,
        },
      };
      const data = await replyFile(reply, op, options.readFile);
      signal.throwIfAborted();
      if (op.kind === "text") {
        if (!op.text || op.text.length > 4096) throw unknownReply();
        options.assertAuthorized(reply);
        const message = await api(
          "sendMessage",
          {
            ...payload,
            text: op.text,
            link_preview_options: { is_disabled: true },
          },
          signal,
        );
        return receipt(reply, op, message);
      }
      if (!data) throw unknownReply();
      const form = new FormData();
      for (const [key, value] of Object.entries(payload))
        form.set(
          key,
          typeof value === "object" ? JSON.stringify(value) : String(value),
        );
      form.set(
        "document",
        new Blob([data.bytes], { type: data.file.mediaType }),
        data.file.name,
      );
      form.set("disable_content_type_detection", "true");
      options.assertAuthorized(reply);
      return receipt(reply, op, await api("sendDocument", form, signal));
    },
    async reconcile(reply, operation, signal) {
      signal.throwIfAborted();
      destination(reply, operation);
      return undefined;
    },
  };
}
