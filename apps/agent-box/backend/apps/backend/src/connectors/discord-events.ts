import type { InboundNormalization } from "./inbound-files.js";
import { createHash } from "node:crypto";
import type {
  ConnectorAccountIdentity,
  ConnectorBinding,
  ConnectorDispositionInput,
} from "./types.js";
export function discordObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function discordId(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}
export function discordFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
export function discordConversationId(
  guildId: string | null,
  channelId: string,
  parentId: string | null = null,
): string {
  return JSON.stringify(["discord", guildId, channelId, parentId]);
}
/** Receives metadata only from the authenticated fixed-origin channel endpoint. */
export function normalizeDiscordDispatch(
  options: InboundNormalization & {
    account: ConnectorAccountIdentity;
    sessionId: string;
    sequence: number;
    type: string;
    data: unknown;
    channel?: unknown;
    bindings: readonly ConnectorBinding[];
  },
): ConnectorDispositionInput {
  const { account, sessionId, sequence, type, data, bindings } = options;
  const common = {
    eventId:
      type === "MESSAGE_CREATE" && discordId(discordObject(data).id)
        ? discordFingerprint(["message", discordObject(data).id])
        : discordFingerprint(["dispatch", sessionId, sequence]),
    fingerprint: discordFingerprint([type, data]),
  };
  const reject = (
    status: Exclude<ConnectorDispositionInput["status"], "accepted">,
  ): ConnectorDispositionInput => ({ ...common, status });
  if (type !== "MESSAGE_CREATE") return reject("unsupported_event");
  const message = discordObject(data),
    author = discordObject(message.author),
    channel = discordObject(options.channel);
  if (
    author.id === account.accountId ||
    author.bot === true ||
    author.system === true ||
    message.webhook_id != null
  )
    return reject("self_or_bot");
  if (
    (author.bot !== undefined && typeof author.bot !== "boolean") ||
    (author.system !== undefined && typeof author.system !== "boolean")
  )
    return reject("unsupported_event");
  if (message.type !== 0 && message.type !== 19)
    return reject("unsupported_event");
  if (
    message.flags !== undefined &&
    (!Number.isSafeInteger(message.flags) ||
      (message.flags as number) < 0 ||
      ((message.flags as number) & 64) !== 0)
  )
    return reject("unsupported_event");
  if (
    !discordId(message.id) ||
    !discordId(message.channel_id) ||
    !discordId(author.id) ||
    channel.id !== message.channel_id
  )
    return reject("unauthorized");
  let guildId: string | null = null,
    parentId: string | null = null;
  if (channel.type === 1) {
    if (
      message.guild_id != null ||
      channel.guild_id != null ||
      !Array.isArray(channel.recipients) ||
      channel.recipients.length !== 1 ||
      discordObject(channel.recipients[0]).id !== author.id
    )
      return reject("unauthorized");
  } else if (
    channel.type === 0 ||
    channel.type === 5 ||
    channel.type === 10 ||
    channel.type === 11 ||
    channel.type === 12
  ) {
    if (!discordId(channel.guild_id) || message.guild_id !== channel.guild_id)
      return reject("unauthorized");
    guildId = channel.guild_id;
    if (channel.type === 10 || channel.type === 11 || channel.type === 12) {
      if (!discordId(channel.parent_id)) return reject("unauthorized");
      parentId = channel.parent_id;
    }
  } else return reject("unauthorized");
  const conversationId = discordConversationId(
    guildId,
    message.channel_id,
    parentId,
  );
  const binding = bindings.find(
    (row) =>
      row.enabled &&
      row.provider === "discord" &&
      row.accountId === account.accountId &&
      row.credentialGeneration === account.credentialGeneration &&
      row.chatId === message.channel_id &&
      row.conversationId === conversationId &&
      row.allowedUserIds.includes(author.id as string),
  );
  if (!binding) return reject("unauthorized");
  if (message.attachments !== undefined && !Array.isArray(message.attachments))
    return reject("unsupported_file");
  const hasFiles =
    Array.isArray(message.attachments) && message.attachments.length > 0;
  if (message.message_snapshots != null) return reject("unsupported_context");
  let replyToNativeMessageId: string | undefined;
  if (
    message.type === 19 ||
    message.message_reference != null ||
    message.referenced_message != null
  ) {
    const reference = discordObject(message.message_reference);
    if (
      message.type !== 19 ||
      !discordId(reference.message_id) ||
      (reference.type !== undefined && reference.type !== 0) ||
      (reference.channel_id !== undefined &&
        reference.channel_id !== message.channel_id) ||
      (reference.guild_id !== undefined && reference.guild_id !== guildId)
    )
      return reject("unsupported_context");
    replyToNativeMessageId = options.resolveReplyReference?.({
      provider: "discord",
      accountId: account.accountId,
      chatId: message.channel_id,
      conversationId,
      messageId: reference.message_id,
    })?.nativeMessageId;
    if (!replyToNativeMessageId) return reject("unsupported_context");
  }
  if (hasFiles && options.attachmentIds === undefined)
    return reject("unsupported_file");
  if (
    typeof message.content !== "string" ||
    (!message.content.trim() && !hasFiles) ||
    message.content.length > 32000 ||
    message.content.includes("\0")
  )
    return reject("content_unavailable");
  return {
    ...common,
    status: "accepted",
    bindingId: binding.id,
    bindingRevision: binding.revision,
    event: {
      provider: account.provider,
      accountId: account.accountId,
      credentialGeneration: account.credentialGeneration,
      eventId: common.eventId,
      chatId: message.channel_id,
      conversationId,
      messageId: message.id,
      userId: author.id,
      text: message.content,
      ...(hasFiles && options.attachmentIds?.length
        ? { attachmentIds: [...options.attachmentIds] }
        : {}),
      ...(replyToNativeMessageId ? { replyToNativeMessageId } : {}),
    },
  };
}
