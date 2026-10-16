import { RuntimeError } from "./types.js";
import { taskOutputPaths } from "./task-outputs.js";
export interface ConversationOutputContext {
  channelId: string;
  branchId?: string;
}
export interface ConversationOutputScope extends ConversationOutputContext {
  profileId: string;
  threadId: string;
  runId: string;
}
export interface ConversationOutputMetadata {
  id: string;
  scope: ConversationOutputScope;
  name: string;
  size: number;
  sha256: string;
  mediaType: string;
}
export interface ConversationOutputAcquisition {
  prepare(scope: ConversationOutputScope, signal: AbortSignal): Promise<string>;
  acquire(
    scope: ConversationOutputScope,
    paths: readonly string[],
    signal: AbortSignal,
  ): Promise<ConversationOutputMetadata[]>;
}
function invalid(): never {
  throw new RuntimeError(
    "invalid",
    "Invalid conversation output scope or manifest",
  );
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.hasOwn(value, key) ||
        !("value" in Object.getOwnPropertyDescriptor(value, key)!),
    )
  )
    invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 200): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    value.length <= max &&
    !Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  );
}
export function conversationOutputContext(
  value: ConversationOutputContext,
): ConversationOutputContext {
  object(value, [
    "channelId",
    ...(Object.hasOwn(value, "branchId") ? ["branchId"] : []),
  ]);
  if (
    !text(value.channelId) ||
    (value.branchId !== undefined && !text(value.branchId))
  )
    invalid();
  return {
    channelId: value.channelId,
    ...(value.branchId !== undefined ? { branchId: value.branchId } : {}),
  };
}
export function conversationOutputScope(
  value: ConversationOutputScope,
): ConversationOutputScope {
  object(value, [
    "profileId",
    "threadId",
    "runId",
    "channelId",
    ...(Object.hasOwn(value, "branchId") ? ["branchId"] : []),
  ]);
  if (!text(value.profileId) || !text(value.threadId) || !text(value.runId))
    invalid();
  return {
    profileId: value.profileId,
    threadId: value.threadId,
    runId: value.runId,
    ...conversationOutputContext({
      channelId: value.channelId,
      ...(value.branchId !== undefined ? { branchId: value.branchId } : {}),
    }),
  };
}
export const conversationOutputPaths = taskOutputPaths;
export function conversationOutputManifest(
  value: unknown,
  input: ConversationOutputScope,
): ConversationOutputMetadata[] {
  const scope = conversationOutputScope(input);
  if (!Array.isArray(value) || !value.length || value.length > 16) invalid();
  let total = 0;
  const ids = new Set<string>();
  return Array.from(value, (item) => {
    const row = object(item, [
      "id",
      "scope",
      "name",
      "size",
      "sha256",
      "mediaType",
    ]);
    if (
      JSON.stringify(
        conversationOutputScope(row.scope as ConversationOutputScope),
      ) !== JSON.stringify(scope) ||
      !text(row.id) ||
      ids.has(row.id) ||
      !text(row.name, 255) ||
      /[\\/]/.test(row.name) ||
      row.name === "." ||
      row.name === ".." ||
      Buffer.byteLength(row.name) > 255 ||
      !Number.isSafeInteger(row.size) ||
      (row.size as number) < 0 ||
      (row.size as number) > 4 * 1024 * 1024 ||
      typeof row.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.sha256) ||
      !text(row.mediaType, 128) ||
      !/^[-\w.+]+\/[-\w.+]+$/.test(row.mediaType)
    )
      invalid();
    total += row.size as number;
    if (total > 16 * 1024 * 1024) invalid();
    ids.add(row.id);
    return {
      id: row.id,
      scope: { ...scope },
      name: row.name,
      size: row.size as number,
      sha256: row.sha256,
      mediaType: row.mediaType,
    };
  });
}
export function admittedConversationOutputs(
  value: unknown,
  scope: ConversationOutputScope,
  paths: readonly string[],
): ConversationOutputMetadata[] {
  const outputs = conversationOutputManifest(value, scope);
  if (
    outputs.length !== paths.length ||
    outputs.some((file, i) => file.name !== paths[i]!.split("/").at(-1))
  )
    invalid();
  return outputs;
}
