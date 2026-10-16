import type { DatabaseSync } from "node:sqlite";

export interface ThreadWork {
  state: "idle" | "working" | "researching" | "waiting";
  pendingInteractions: number;
  runId: string | null;
}

/** Public work metadata only. Indexed to one thread and its current run. */
export function threadWork(db: DatabaseSync, threadId: string): ThreadWork {
  const run = db
    .prepare(
      "SELECT id FROM runs WHERE thread_id=? AND json_extract(value,'$.state') IN ('running','attention_required') AND json_extract(value,'$.state')='running' ORDER BY rowid DESC LIMIT 1",
    )
    .get(threadId);
  if (!run) return { state: "idle", pendingInteractions: 0, runId: null };
  const runId = String(run.id);
  const pendingInteractions = Number(
    db
      .prepare(
        "SELECT COUNT(*) AS count FROM interactions WHERE run_id=? AND json_extract(value,'$.state')='pending'",
      )
      .get(runId)!.count,
  );
  if (pendingInteractions)
    return { state: "waiting", pendingInteractions, runId };
  // Count unmatched starts, including overlapping uses of the same desktop tool.
  // The returned result is a single boolean; no transcripts or tool arguments leave the store.
  const research = db
    .prepare(
      `SELECT 1 FROM events
    WHERE run_id=? AND json_extract(value,'$.type')='tool'
    AND json_extract(value,'$.name') IN ('desktop_capture','window_capture','desktop_input','window_input')
    GROUP BY json_extract(value,'$.name')
    HAVING SUM(CASE json_extract(value,'$.state') WHEN 'started' THEN 1 WHEN 'completed' THEN -1 WHEN 'failed' THEN -1 ELSE 0 END)>0 LIMIT 1`,
    )
    .get(runId);
  return {
    state: research ? "researching" : "working",
    pendingInteractions: 0,
    runId,
  };
}
