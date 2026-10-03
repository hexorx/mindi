import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  RuntimeError,
  type AttachmentMetadata,
  type ResolvedAttachment,
  type Thread,
  type WorkerAttachmentSource,
} from "./types.js";
export const MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
export function assertAttachmentBudget(values: AttachmentMetadata[]) {
  if (
    values.some(
      (value) => !value || !Number.isSafeInteger(value.size) || value.size < 0,
    )
  )
    throw new RuntimeError("invalid", "Invalid attachment size");
  if (
    values.reduce((total, value) => total + value.size, 0) >
    MAX_ATTACHMENT_BYTES
  )
    throw new RuntimeError(
      "invalid",
      "Attachments exceed the aggregate 24 MiB limit; no files were truncated",
    );
}
export type AttachmentResolver = (
  thread: Thread,
  ids: string[],
) => ResolvedAttachment[];
export function attachmentIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    new Set(value).size !== value.length ||
    value.some(
      (id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id),
    )
  )
    throw new RuntimeError(
      "invalid",
      "Attachments require at most 16 unique valid IDs",
    );
  return [...value];
}
export function metadata(value: ResolvedAttachment): AttachmentMetadata {
  return {
    id: value.id,
    scope:
      value.scope.kind === "thread"
        ? {
            kind: "thread",
            threadId: value.scope.threadId,
            profileId: value.scope.profileId,
          }
        : {
            kind: "channel",
            channelId: value.scope.channelId,
            ...(value.scope.branchId === undefined
              ? {}
              : { branchId: value.scope.branchId }),
            profileId: value.scope.profileId,
          },
    name: value.name,
    mediaType: value.mediaType,
    size: value.size,
    sha256: value.sha256,
    createdAt: value.createdAt,
  };
}
export function resolveAttachments(
  thread: Thread,
  ids: string[],
  resolver?: AttachmentResolver,
): ResolvedAttachment[] {
  if (!ids.length) return [];
  if (!resolver)
    throw new RuntimeError(
      "unavailable",
      "Attachment resolution is unavailable",
    );
  const values = resolver(structuredClone(thread), [...ids]);
  if (!Array.isArray(values) || values.length !== ids.length)
    throw new RuntimeError(
      "invalid",
      "Attachment resolution did not return every requested file",
    );
  assertAttachmentBudget(values);
  return values.map((value, index) => {
    if (
      !value ||
      value.id !== ids[index] ||
      !value.scope ||
      value.scope.profileId !== thread.profileId ||
      (value.scope.kind === "thread"
        ? value.scope.threadId !== thread.id
        : value.scope.kind !== "channel" ||
          thread.owner?.kind !== "channel" ||
          value.scope.channelId !== thread.owner.id) ||
      typeof value.name !== "string" ||
      !value.name ||
      value.name.length > 255 ||
      typeof value.mediaType !== "string" ||
      !value.mediaType ||
      value.mediaType.length > 128 ||
      !Number.isSafeInteger(value.size) ||
      value.size < 0 ||
      value.size > MAX_ATTACHMENT_BYTES ||
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.data !== "string" ||
      value.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
    )
      throw new RuntimeError(
        "invalid",
        "Invalid resolved attachment metadata or scope",
      );
    const bytes = Buffer.from(value.data, "base64");
    if (
      bytes.toString("base64") !== value.data ||
      bytes.length !== value.size ||
      createHash("sha256").update(bytes).digest("hex") !== value.sha256
    )
      throw new RuntimeError(
        "invalid",
        "Attachment content does not match its immutable metadata",
      );
    return { ...metadata(value), data: value.data };
  });
}
export function sameAttachments(
  actual: AttachmentMetadata[],
  expected: AttachmentMetadata[],
) {
  if (!isDeepStrictEqual(actual, expected))
    throw new RuntimeError(
      "conflict",
      "Attachment identity or content changed",
    );
}
export function attachmentSources(
  inherited: WorkerAttachmentSource[] | undefined,
  threadId: string,
  ids: string[],
): WorkerAttachmentSource[] {
  const result = structuredClone(inherited || []);
  if (ids.length) result.push({ threadId, attachmentIds: [...ids] });
  if (
    result.length > 32 ||
    result.reduce((n, s) => n + s.attachmentIds.length, 0) > 64
  )
    throw new RuntimeError(
      "invalid",
      "Reply attachment ancestry exceeds 32 sources or 64 files; no attachments were truncated",
    );
  return result;
}
