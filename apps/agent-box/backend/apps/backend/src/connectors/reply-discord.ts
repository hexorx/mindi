import { createHash } from "node:crypto";
import { discordId } from "../discord-routine-delivery.js";
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
/** Conversation replies have their own deterministic marker, never a routine/task identity. */
export function createDiscordReplyTransport(options: {
  account: ConnectorAccountIdentity;
  token: string;
  request?: typeof fetch;
  readFile?: ConnectorReplyFileReader;
  assertAuthorized: (reply: ConnectorReplyRecord) => void;
}): ConnectorReplyTransport {
  const { provider, accountId, credentialGeneration } = options.account;
  const account = Object.freeze({ provider, accountId, credentialGeneration }),
    token = options.token,
    request = options.request ?? fetch;
  if (
    provider !== "discord" ||
    !discordId(accountId) ||
    !token ||
    token.length > 16384 ||
    /\s/.test(token) ||
    Array.from(token).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    throw unknownReply();
  function destination(
    reply: ConnectorReplyRecord,
    op?: ConnectorReplyOperation,
  ) {
    replyScope(reply, account, op);
    let p: unknown;
    try {
      p = JSON.parse(reply.binding.conversationId);
    } catch {
      throw unknownReply();
    }
    if (
      !Array.isArray(p) ||
      p.length !== 4 ||
      p[0] !== "discord" ||
      (p[1] !== null && !discordId(p[1])) ||
      !discordId(p[2]) ||
      (p[3] !== null && !discordId(p[3])) ||
      p[2] !== reply.binding.chatId ||
      (p[1] === null && p[3] !== null) ||
      JSON.stringify(p) !== reply.binding.conversationId ||
      !discordId(reply.event.messageId)
    )
      throw unknownReply();
    return {
      guildId: p[1] as string | null,
      channelId: p[2] as string,
      parentId: p[3] as string | null,
    };
  }
  async function api(
    path: string,
    signal: AbortSignal,
    body?: Record<string, unknown> | FormData,
  ) {
    const multipart = body instanceof FormData;
    const response = await replyRequest(
      request,
      `https://discord.com/api/v10${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bot ${token}`,
          ...(body !== undefined && !multipart
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(body === undefined
          ? {}
          : { body: multipart ? body : JSON.stringify(body) }),
      },
      signal,
    );
    if (response.status === 429) {
      let delay: unknown;
      try {
        delay = replyObject(response.value).retry_after;
      } catch {
        throw new ConnectorReplyRateLimitUnknown();
      }
      if (
        typeof delay !== "number" ||
        !Number.isFinite(delay) ||
        delay < 0 ||
        delay > 86400
      )
        throw new ConnectorReplyRateLimitUnknown();
      throw new ConnectorReplyRejected(Math.ceil(delay * 1000));
    }
    if (!response.ok) {
      const value = replyObject(response.value);
      if (
        [400, 401, 403, 404, 405, 413].includes(response.status) &&
        Number.isSafeInteger(value.code) &&
        typeof value.message === "string"
      )
        throw new ConnectorReplyRejected(5000);
      throw unknownReply();
    }
    return response.value;
  }
  function marker(reply: ConnectorReplyRecord, op: ConnectorReplyOperation) {
    return `mindi-reply:${createHash("sha256")
      .update(
        JSON.stringify([accountId, reply.id, reply.nativeDeliveryId, op.id]),
      )
      .digest("hex")}`;
  }
  function matched(
    reply: ConnectorReplyRecord,
    op: ConnectorReplyOperation,
    value: unknown,
  ): ConnectorReplyReceipt | undefined {
    const target = destination(reply, op),
      m = replyObject(value),
      author = replyObject(m.author);
    const ref =
      m.message_reference === undefined ? {} : replyObject(m.message_reference);
    if (
      !discordId(m.id) ||
      m.channel_id !== target.channelId ||
      (m.guild_id !== undefined && m.guild_id !== target.guildId) ||
      author.id !== accountId ||
      author.bot !== true ||
      m.webhook_id !== undefined ||
      m.type !== 19 ||
      m.content !== (op.kind === "text" ? op.text : "") ||
      !Array.isArray(m.attachments) ||
      m.attachments.length !== (op.kind === "file" ? 1 : 0) ||
      !Array.isArray(m.embeds) ||
      m.embeds.length !== 1 ||
      ref.message_id !== reply.event.messageId ||
      ref.channel_id !== target.channelId ||
      (target.guildId !== null && ref.guild_id !== target.guildId)
    )
      return;
    const embed = replyObject(m.embeds[0]);
    if (replyObject(embed.footer).text !== marker(reply, op)) return;
    if (op.kind === "file") {
      const f = reply.files.find((file) => file.id === op.fileId),
        attachment = replyObject(m.attachments[0]);
      if (
        !f ||
        !discordId(attachment.id) ||
        attachment.filename !== f.name ||
        attachment.size !== f.size ||
        attachment.content_type !== f.mediaType ||
        attachment.ephemeral === true
      )
        return;
    }
    return {
      provider: "discord",
      accountId,
      chatId: target.channelId,
      conversationId: reply.binding.conversationId,
      messageId: m.id,
    };
  }
  return {
    account,
    async verify(reply, signal) {
      const target = destination(reply),
        me = replyObject(await api("/users/@me", signal));
      if (me.id !== accountId || me.bot !== true) throw unknownReply();
      const channel = replyObject(
        await api(`/channels/${target.channelId}`, signal),
      );
      if (channel.id !== target.channelId) throw unknownReply();
      if (target.guildId === null) {
        if (
          channel.type !== 1 ||
          channel.guild_id !== undefined ||
          !Array.isArray(channel.recipients) ||
          channel.recipients.length !== 1 ||
          replyObject(channel.recipients[0]).id !== reply.event.userId ||
          !reply.binding.allowedUserIds.includes(reply.event.userId)
        )
          throw unknownReply();
      } else {
        if (channel.guild_id !== target.guildId) throw unknownReply();
        if (target.parentId === null) {
          if (channel.type !== 0 && channel.type !== 5) throw unknownReply();
        } else {
          const metadata = replyObject(channel.thread_metadata);
          if (
            ![10, 11, 12].includes(channel.type as number) ||
            channel.parent_id !== target.parentId ||
            metadata.archived !== false ||
            metadata.locked !== false
          )
            throw unknownReply();
          const parent = replyObject(
            await api(`/channels/${target.parentId}`, signal),
          );
          if (
            parent.id !== target.parentId ||
            parent.guild_id !== target.guildId ||
            ![0, 5, 15, 16].includes(parent.type as number)
          )
            throw unknownReply();
        }
      }
    },
    async send(reply, op, signal) {
      const target = destination(reply, op);
      signal.throwIfAborted();
      if (op.kind === "text" && (!op.text || op.text.length > 2000))
        throw unknownReply();
      const data = await replyFile(reply, op, options.readFile);
      signal.throwIfAborted();
      const payload: Record<string, unknown> = {
        content: op.kind === "text" ? op.text : "",
        allowed_mentions: { parse: [], replied_user: false },
        message_reference: {
          message_id: reply.event.messageId,
          channel_id: target.channelId,
          ...(target.guildId === null ? {} : { guild_id: target.guildId }),
          fail_if_not_exists: true,
        },
        embeds: [{ footer: { text: marker(reply, op) } }],
      };
      let body: Record<string, unknown> | FormData = payload;
      if (data) {
        payload.attachments = [{ id: 0, filename: data.file.name }];
        const form = new FormData();
        form.set("payload_json", JSON.stringify(payload));
        form.set(
          "files[0]",
          new Blob([data.bytes], { type: data.file.mediaType }),
          data.file.name,
        );
        body = form;
      }
      options.assertAuthorized(reply);
      const result = matched(
        reply,
        op,
        await api(`/channels/${target.channelId}/messages`, signal, body),
      );
      if (!result) throw unknownReply();
      return result;
    },
    async reconcile(reply, op, signal) {
      const target = destination(reply, op),
        found = new Map<string, ConnectorReplyReceipt>();
      let before: string | undefined;
      for (let page = 0; page < 10; page++) {
        const values = await api(
          `/channels/${target.channelId}/messages?limit=100${before ? `&before=${before}` : ""}`,
          signal,
        );
        if (!Array.isArray(values) || values.length > 100) throw unknownReply();
        let last = before;
        for (const value of values) {
          const row = replyObject(value);
          if (
            !discordId(row.id) ||
            row.channel_id !== target.channelId ||
            (last !== undefined && BigInt(row.id) >= BigInt(last))
          )
            throw unknownReply();
          last = row.id;
          // Other people's messages cannot attest a receipt, nor need they be shaped like one.
          if (replyObject(row.author).id !== accountId) continue;
          const receipt = matched(reply, op, row);
          if (receipt) found.set(receipt.messageId, receipt);
        }
        if (found.size > 1) throw unknownReply();
        if (values.length < 100) return found.values().next().value;
        before = last;
      }
      // An incomplete scan is uncertain even if one candidate was found.
      throw unknownReply();
    },
  };
}
