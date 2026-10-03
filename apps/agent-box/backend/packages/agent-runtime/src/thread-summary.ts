import type { DatabaseSync } from "node:sqlite";
import type { ThreadSummary } from "./types.js";

/** Matches NativeChat's one user per run and nonempty terminal assistant projection. */
export function threadSummary(
  db: DatabaseSync,
  threadId: string,
): ThreadSummary {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS users,
    COALESCE(SUM(CASE WHEN json_extract(r.value,'$.state') <> 'running' AND EXISTS (
      SELECT 1 FROM events e WHERE e.run_id=r.id AND json_extract(e.value,'$.type')='text'
      AND length(CAST(json_extract(e.value,'$.text') AS BLOB)) > 0
    ) THEN 1 ELSE 0 END),0) AS assistants,
    COALESCE(SUM(CASE WHEN json_extract(r.value,'$.state')='running' THEN 1 ELSE 0 END),0) AS running
    FROM runs r WHERE r.thread_id=?`,
    )
    .get(threadId)!;
  const users = Number(row.users),
    assistants = Number(row.assistants);
  return {
    threadId,
    messageCount: users + assistants,
    participants: [
      ...(users ? ["user" as const] : []),
      ...(assistants ? ["assistant" as const] : []),
    ],
    running: Number(row.running) > 0,
  };
}
