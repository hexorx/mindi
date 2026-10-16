import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { RuntimeError, type ThreadOwner } from "./types.js";
export interface ActivityInput {
  limit?: number;
  after?: string;
  profileId?: string;
}
interface Cursor {
  database: string;
  profileId: string | null;
  after: number;
  watermark: number;
}
export function runtimeActivity(db: DatabaseSync, input: ActivityInput = {}) {
  const limit = input?.limit ?? 50;
  const invalid = () => new RuntimeError("invalid", "Invalid activity page");
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (k) => !["limit", "after", "profileId"].includes(k),
    ) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (input.profileId !== undefined &&
      (typeof input.profileId !== "string" ||
        !/^[a-z][a-z0-9_-]{0,63}$/.test(input.profileId)))
  )
    throw invalid();
  const database = String(
    db
      .prepare("SELECT id FROM runtime_history_identity WHERE singleton=1")
      .get()!.id,
  );
  const maximum = Number(
    db.prepare("SELECT COALESCE(MAX(rowid),0) AS maximum FROM runs").get()!
      .maximum,
  );
  let after = 0,
    watermark = maximum;
  if (input.after !== undefined) {
    try {
      if (
        typeof input.after !== "string" ||
        input.after.length > 2048 ||
        !/^[A-Za-z0-9_-]+$/.test(input.after)
      )
        throw invalid();
      const bytes = Buffer.from(input.after, "base64url");
      if (bytes.toString("base64url") !== input.after) throw invalid();
      const c = JSON.parse(bytes.toString()) as Cursor;
      if (
        !c ||
        Object.keys(c).sort().join(",") !==
          "after,database,profileId,watermark" ||
        c.database !== database ||
        c.profileId !== (input.profileId ?? null) ||
        !Number.isSafeInteger(c.after) ||
        !Number.isSafeInteger(c.watermark) ||
        c.after < 1 ||
        c.after > c.watermark ||
        c.watermark > maximum
      )
        throw invalid();
      after = c.after;
      watermark = c.watermark;
    } catch {
      throw invalid();
    }
  }
  const params: SQLInputValue[] =
    input.profileId === undefined ? [] : [input.profileId];
  const base = `SELECT r.rowid AS seq,r.id AS run_id,r.thread_id,
 json_extract(t.value,'$.profileId') AS profile_id,
 json_extract(t.value,'$.owner') AS owner,
 json_extract(r.value,'$.state') AS state,
 json_extract(r.value,'$.createdAt') AS created_at,
 (SELECT COUNT(*) FROM interactions i WHERE i.run_id=r.id AND json_extract(i.value,'$.state')='pending') AS pending
 FROM runs r JOIN threads t ON t.id=r.thread_id
 WHERE json_extract(r.value,'$.state') IN ('running','attention_required')${input.profileId === undefined ? "" : " AND json_extract(t.value,'$.profileId')=?"}`;
  const profiles = db
    .prepare(
      `WITH current AS (${base}) SELECT profile_id,SUM(state='running') AS running,SUM(state='attention_required') AS attention,SUM(pending) AS pending_total FROM current GROUP BY profile_id ORDER BY profile_id`,
    )
    .all(...params)
    .map((row) => ({
      profileId: String(row.profile_id),
      running: Number(row.running),
      attentionRequired: Number(row.attention),
      pendingInteractions: Number(row.pending_total),
    }));
  const rows = db
    .prepare(
      `WITH current AS (${base}) SELECT * FROM current WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?`,
    )
    .all(...params, after, watermark, limit + 1);
  const selected = rows.slice(0, limit);
  const items = selected.map((row) => ({
    runId: String(row.run_id),
    threadId: String(row.thread_id),
    profileId: String(row.profile_id),
    owner: (row.owner
      ? JSON.parse(String(row.owner))
      : { kind: "unresolved" }) as ThreadOwner,
    state: String(row.state) as "running" | "attention_required",
    createdAt: String(row.created_at),
    pendingInteractions: Number(row.pending),
  }));
  return {
    profiles,
    items,
    nextCursor:
      rows.length > limit
        ? Buffer.from(
            JSON.stringify({
              database,
              profileId: input.profileId ?? null,
              after: Number(selected.at(-1)!.seq),
              watermark,
            } satisfies Cursor),
          ).toString("base64url")
        : null,
  };
}
