import { ConnectorReplyRateLimitUnknown } from "./replies.js";
import { createHash } from "node:crypto";
import type {
  ConnectorAccountIdentity,
  ConnectorReplyFile,
  ConnectorReplyOperation,
  ConnectorReplyRecord,
} from "./types.js";
export const unknownReply = () =>
  Error("Connector provider reply outcome is unknown");
export function replyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unknownReply();
  return value as Record<string, unknown>;
}
export type ConnectorReplyFileReader = (
  file: ConnectorReplyFile,
  reply: ConnectorReplyRecord,
) => Promise<{ metadata: ConnectorReplyFile; bytes: Uint8Array }>;
export function replyScope(
  reply: ConnectorReplyRecord,
  account: ConnectorAccountIdentity,
  operation?: ConnectorReplyOperation,
) {
  const b = reply.binding,
    e = reply.event;
  if (
    !b.enabled ||
    b.provider !== account.provider ||
    b.accountId !== account.accountId ||
    b.credentialGeneration !== account.credentialGeneration ||
    e.provider !== b.provider ||
    e.accountId !== b.accountId ||
    e.credentialGeneration !== b.credentialGeneration ||
    e.chatId !== b.chatId ||
    e.conversationId !== b.conversationId ||
    !b.allowedUserIds.includes(e.userId)
  )
    throw unknownReply();
  if (operation) {
    const saved = reply.operations.find((p) => p.id === operation.id);
    if (
      !saved ||
      saved.kind !== operation.kind ||
      (operation.kind === "text"
        ? saved.kind !== "text" || saved.text !== operation.text
        : saved.kind !== "file" || saved.fileId !== operation.fileId)
    )
      throw unknownReply();
  }
}
export async function replyFile(
  reply: ConnectorReplyRecord,
  operation: ConnectorReplyOperation,
  readFile?: ConnectorReplyFileReader,
) {
  if (operation.kind !== "file") return undefined;
  const file = reply.files.find((f) => f.id === operation.fileId);
  if (
    !file ||
    !readFile ||
    !Number.isSafeInteger(file.size) ||
    file.size < 0 ||
    file.size > 8 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/.test(file.sha256) ||
    !file.name ||
    file.name.length > 240 ||
    /[/\\]/.test(file.name) ||
    Array.from(file.name).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    ) ||
    !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(file.mediaType)
  )
    throw unknownReply();
  const result = await readFile(structuredClone(file), structuredClone(reply));
  const metadata = result.metadata;
  if (
    !(result.bytes instanceof Uint8Array) ||
    result.bytes.byteLength !== file.size ||
    createHash("sha256").update(result.bytes).digest("hex") !== file.sha256 ||
    metadata.id !== file.id ||
    metadata.name !== file.name ||
    metadata.mediaType !== file.mediaType ||
    metadata.size !== file.size ||
    metadata.sha256 !== file.sha256
  )
    throw unknownReply();
  return { file, bytes: new Uint8Array(result.bytes) };
}
/** The parent abort and total deadline cover headers and streamed bodies. */
export async function replyRequest(
  request: typeof fetch,
  url: string,
  init: RequestInit,
  parent: AbortSignal,
): Promise<{ status: number; ok: boolean; value: unknown }> {
  const signal = AbortSignal.any([parent, AbortSignal.timeout(30000)]);
  let rateLimited = false;
  try {
    signal.throwIfAborted();
    const response = await request(url, { ...init, redirect: "error", signal });
    rateLimited = response.status === 429;
    const reader = response.body?.getReader();
    if (!reader) throw unknownReply();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 1024 * 1024) throw unknownReply();
        chunks.push(part.value);
      }
    } catch {
      await reader.cancel().catch(() => {});
      throw unknownReply();
    } finally {
      reader.releaseLock();
    }
    return {
      status: response.status,
      ok: response.ok,
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      ),
    };
  } catch {
    if (rateLimited) throw new ConnectorReplyRateLimitUnknown();
    throw unknownReply();
  }
}
