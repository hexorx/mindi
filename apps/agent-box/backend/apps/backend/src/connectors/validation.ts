import {
  ConnectorError,
  type ConnectorBinding,
  type ConnectorEvent,
  type ConnectorProvider,
} from "./types.js";
export function invalid(message: string): never {
  throw new ConnectorError("invalid", message);
}
export function object(
  input: unknown,
  keys: string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input))
  )
    invalid("Invalid connector object");
  for (const key of Reflect.ownKeys(input)) {
    if (
      typeof key !== "string" ||
      !keys.includes(key) ||
      !("value" in Object.getOwnPropertyDescriptor(input, key)!)
    )
      invalid("Invalid connector fields");
  }
  return input as Record<string, unknown>;
}
export function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > 200 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  )
    invalid("Invalid connector identity");
  return value;
}
function provider(value: unknown): ConnectorProvider {
  if (value !== "telegram" && value !== "discord")
    invalid("Invalid connector provider");
  return value;
}
export function binding(input: unknown): ConnectorBinding {
  const row = object(input, [
    "id",
    "revision",
    "enabled",
    "provider",
    "accountId",
    "credentialGeneration",
    "chatId",
    "conversationId",
    "allowedUserIds",
    "profileId",
    "channelId",
  ]);
  if (
    !Number.isSafeInteger(row.revision) ||
    (row.revision as number) < 1 ||
    typeof row.enabled !== "boolean"
  )
    invalid("Invalid binding revision or enabled state");
  if (
    !Array.isArray(row.allowedUserIds) ||
    row.allowedUserIds.length < 1 ||
    row.allowedUserIds.length > 98
  )
    invalid("Invalid binding allowlist");
  const users = Array.from(row.allowedUserIds, id).sort();
  if (new Set(users).size !== users.length || users.includes("*"))
    invalid("Invalid binding allowlist");
  const profileId = id(row.profileId);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(profileId))
    invalid("Invalid recipient profile");
  return {
    id: id(row.id),
    revision: row.revision as number,
    enabled: row.enabled,
    provider: provider(row.provider),
    accountId: id(row.accountId),
    credentialGeneration: id(row.credentialGeneration),
    chatId: id(row.chatId),
    conversationId: id(row.conversationId),
    allowedUserIds: users,
    profileId,
    channelId: id(row.channelId),
  };
}
export function event(input: unknown): ConnectorEvent {
  const row = object(input, [
    "provider",
    "accountId",
    "credentialGeneration",
    "eventId",
    "chatId",
    "conversationId",
    "messageId",
    "userId",
    "text",
    "attachmentIds",
    "replyToNativeMessageId",
  ]);
  let attachmentIds: string[] | undefined;
  if (row.attachmentIds !== undefined) {
    if (
      !Array.isArray(row.attachmentIds) ||
      row.attachmentIds.length > 16 ||
      row.attachmentIds.some(
        (value) =>
          typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value),
      )
    )
      invalid("Invalid connector attachments");
    attachmentIds = [...row.attachmentIds] as string[];
    if (new Set(attachmentIds).size !== attachmentIds.length)
      invalid("Duplicate connector attachments");
  }
  const replyToNativeMessageId =
    row.replyToNativeMessageId === undefined
      ? undefined
      : id(row.replyToNativeMessageId);
  if (
    typeof row.text !== "string" ||
    (!row.text.trim() && !attachmentIds?.length) ||
    row.text.length > 32000 ||
    row.text.includes("\0")
  )
    invalid("Invalid connector text");
  return {
    provider: provider(row.provider),
    accountId: id(row.accountId),
    credentialGeneration: id(row.credentialGeneration),
    eventId: id(row.eventId),
    chatId: id(row.chatId),
    conversationId: id(row.conversationId),
    messageId: id(row.messageId),
    userId: id(row.userId),
    text: row.text,
    ...(attachmentIds?.length ? { attachmentIds } : {}),
    ...(replyToNativeMessageId ? { replyToNativeMessageId } : {}),
  };
}
