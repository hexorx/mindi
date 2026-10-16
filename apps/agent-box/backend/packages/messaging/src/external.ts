import { createHash } from "node:crypto";
import {
  MessagingError,
  type ExternalProvenance,
  type ExternalConversationBinding,
  type ChannelAttachmentScope,
  type ExternalAttachmentMetadata,
} from "./types.js";

function fail(): never {
  throw new MessagingError("invalid", "Invalid external identity or binding");
}
function object(value: unknown, fields: string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail();
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !fields.includes(key) ||
        !("value" in Object.getOwnPropertyDescriptor(value, key)!),
    )
  )
    fail();
}
function id(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.length > 200 ||
    Array.from(value).some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    fail();
  return value;
}
const identityFields = [
  "bindingId",
  "bindingRevision",
  "provider",
  "accountId",
  "chatId",
  "conversationId",
];
function identity(input: Omit<ExternalProvenance, "userId" | "messageId">) {
  if (input.provider !== "telegram" && input.provider !== "discord") fail();
  if (!Number.isSafeInteger(input.bindingRevision) || input.bindingRevision < 1)
    fail();
  return {
    bindingId: id(input.bindingId),
    bindingRevision: input.bindingRevision,
    provider: input.provider,
    accountId: id(input.accountId),
    chatId: id(input.chatId),
    conversationId: id(input.conversationId),
  };
}
export function externalProvenance(
  input: ExternalProvenance,
): ExternalProvenance {
  object(input, [...identityFields, "userId", "messageId"]);
  return {
    ...identity(input),
    userId: id(input.userId),
    messageId: id(input.messageId),
  };
}
export function externalBinding(
  input: ExternalConversationBinding,
): ExternalConversationBinding {
  object(input, [
    ...identityFields,
    "channelId",
    "profileId",
    "allowedUserIds",
  ]);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id(input.profileId))) fail();
  if (
    !Array.isArray(input.allowedUserIds) ||
    Object.getPrototypeOf(input.allowedUserIds) !== Array.prototype ||
    input.allowedUserIds.length < 1 ||
    input.allowedUserIds.length > 98
  )
    fail();
  const allowedUserIds: string[] = [];
  for (let i = 0; i < input.allowedUserIds.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(
      input.allowedUserIds,
      String(i),
    );
    if (!descriptor || !("value" in descriptor)) fail();
    allowedUserIds.push(id(descriptor.value));
  }
  if (allowedUserIds.includes("*")) fail();
  if (new Set(allowedUserIds).size !== allowedUserIds.length) fail();
  return {
    ...identity(input),
    channelId: id(input.channelId),
    profileId: input.profileId,
    allowedUserIds: allowedUserIds.sort(),
  };
}
function hash(values: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex");
}
export function externalMemberId(
  input: Pick<ExternalProvenance, "provider" | "accountId" | "userId">,
): string {
  if (input.provider !== "telegram" && input.provider !== "discord") fail();
  return `external:${hash([input.provider, id(input.accountId), id(input.userId)])}`;
}
export function externalConversationKey(
  input: Omit<ExternalProvenance, "userId" | "messageId">,
): string {
  return hash([
    input.bindingId,
    input.bindingRevision,
    input.provider,
    input.accountId,
    input.chatId,
    input.conversationId,
  ]);
}
export function externalMessageKey(input: ExternalProvenance): string {
  return hash([
    input.provider,
    input.accountId,
    ...(input.provider === "telegram" ? [input.chatId] : []),
    input.messageId,
  ]);
}

/** Canonical immutable admission metadata returned only by a trusted byte store. */
export function externalAttachments(
  value: unknown,
  scope: ChannelAttachmentScope,
  provenance: ExternalProvenance,
  ids: string[],
): ExternalAttachmentMetadata[] {
  if (
    !Array.isArray(value) ||
    value.length !== ids.length ||
    !value.length ||
    value.length > 16
  )
    fail();
  let total = 0;
  return Array.from(value, (item, index) => {
    object(item, [
      "id",
      "scope",
      "external",
      "name",
      "mediaType",
      "size",
      "sha256",
      "createdAt",
    ]);
    object(item.scope, ["kind", "channelId", "profileId", "branchId"]);
    if (
      item.id !== ids[index] ||
      item.scope.kind !== "channel" ||
      item.scope.channelId !== scope.channelId ||
      item.scope.profileId !== scope.profileId ||
      (item.scope.branchId ?? null) !== (scope.branchId ?? null) ||
      JSON.stringify(externalProvenance(item.external)) !==
        JSON.stringify(provenance)
    )
      fail();
    if (
      typeof item.name !== "string" ||
      !item.name.trim() ||
      item.name.length > 255 ||
      /[\\/]/.test(item.name) ||
      Array.from(item.name as string).some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      ) ||
      typeof item.mediaType !== "string" ||
      !/^[-\w.+]+\/[-\w.+]+$/.test(item.mediaType) ||
      item.mediaType.length > 128 ||
      !Number.isSafeInteger(item.size) ||
      item.size < 0 ||
      typeof item.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(item.sha256) ||
      typeof item.createdAt !== "string" ||
      !Number.isFinite(Date.parse(item.createdAt))
    )
      fail();
    total += item.size;
    if (total > 24 * 1024 * 1024) fail();
    return structuredClone(item) as ExternalAttachmentMetadata;
  });
}
export function externalAttachmentIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 16 ||
    new Set(value).size !== value.length
  )
    fail();
  return Array.from(value, (entry) => {
    if (typeof entry !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(entry))
      fail();
    return entry;
  });
}
