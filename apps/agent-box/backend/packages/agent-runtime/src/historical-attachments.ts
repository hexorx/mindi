import type { DatabaseSync } from "node:sqlite";
import {
  resolveAttachments,
  sameAttachments,
  metadata,
  type AttachmentResolver,
} from "./attachments.js";
import {
  RuntimeError,
  type Run,
  type Thread,
  type ResolvedAttachment,
} from "./types.js";

/** Durable admission is independent of model-visible journal text. */
export function historicalAttachment(
  db: DatabaseSync,
  run: Run,
  id: string,
  getThread: (id: string) => Thread,
  resolver?: AttachmentResolver,
): ResolvedAttachment {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    throw new RuntimeError("invalid", "Invalid historical attachment ID");
  let thread = getThread(run.threadId);
  const profileId = thread.profileId;
  const current = db
    .prepare("SELECT rowid AS position FROM runs WHERE id=?")
    .get(run.id);
  if (!current) throw new RuntimeError("not_found", "Unknown source run");
  let before = Number(current.position);
  const visited = new Set<string>();
  while (!visited.has(thread.id)) {
    visited.add(thread.id);
    if (thread.profileId !== profileId)
      throw new RuntimeError(
        "conflict",
        "Historical attachment profile mismatch",
      );
    const row = db
      .prepare(
        `SELECT value FROM runs WHERE thread_id=? AND rowid<?
      AND json_extract(value,'$.state')='completed'
      AND EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(runs.value,'$.workerAttachmentMetadata'), json_extract(runs.value,'$.attachments')))
        WHERE json_extract(json_each.value,'$.id')=?)
      ORDER BY rowid DESC LIMIT 1`,
      )
      .get(thread.id, before, id);
    if (row) {
      const source = JSON.parse(String(row.value)) as Run;
      const expected = (source.workerAttachmentMetadata ??
        source.attachments)!.find((file) => file.id === id)!;
      const original = source.workerAttachmentSources?.find((entry) =>
        entry.attachmentIds.includes(id),
      );
      const sourceThread = original ? getThread(original.threadId) : thread;
      if (sourceThread.profileId !== profileId)
        throw new RuntimeError(
          "conflict",
          "Historical source profile mismatch",
        );
      const actual = resolveAttachments(sourceThread, [id], resolver)[0]!;
      sameAttachments([metadata(actual)], [expected]);
      return actual;
    }
    if (!thread.parentId || !thread.branchEntryId) break;
    const boundary = db
      .prepare(
        `SELECT rowid AS position FROM runs WHERE thread_id=?
      AND json_extract(value,'$.userEntryId')=? AND json_extract(value,'$.state')='completed'`,
      )
      .get(thread.parentId, thread.branchEntryId);
    // Unknown checkpoints cannot establish which parent files preceded this branch.
    if (!boundary) break;
    before = Number(boundary.position);
    thread = getThread(thread.parentId);
  }
  throw new RuntimeError(
    "not_found",
    "Attachment is not admitted to this conversation history",
  );
}
