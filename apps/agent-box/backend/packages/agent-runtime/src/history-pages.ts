import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import {
  RuntimeError,
  type Run,
  type Thread,
  type ThreadOwner,
} from "./types.js";

export interface HistoryPageInput {
  limit?: number;
  after?: string;
}
export interface ThreadPageInput extends HistoryPageInput {
  profileId?: string;
  ownerKind?: ThreadOwner["kind"];
}
export interface HistoryPage<T> {
  items: T[];
  nextCursor: string | null;
}
interface Cursor {
  version: 1;
  database: string;
  scope: string;
  watermark: number;
  createdAt: string;
  id: string;
}

/** Bounded history reads. Ownership/recovery must use exhaustive or exact reads. */
export class RuntimeHistoryPages {
  constructor(private readonly db: DatabaseSync) {}

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_history_identity (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS thread_history_order ON threads(json_extract(value,'$.createdAt') DESC,id DESC);
      CREATE INDEX IF NOT EXISTS thread_history_profile_owner ON threads(json_extract(value,'$.profileId'),json_extract(value,'$.owner.kind'),json_extract(value,'$.createdAt') DESC,id DESC);
      CREATE INDEX IF NOT EXISTS run_history_order ON runs(thread_id,json_extract(value,'$.createdAt') DESC,id DESC);
      CREATE INDEX IF NOT EXISTS run_thread_insertion ON runs(thread_id);
      CREATE INDEX IF NOT EXISTS run_current_state ON runs(json_extract(value,'$.state'),thread_id) WHERE json_extract(value,'$.state') IN ('running','attention_required');
    `);
    this.db
      .prepare("INSERT OR IGNORE INTO runtime_history_identity VALUES(1,?)")
      .run(randomUUID());
  }

  threads(input: ThreadPageInput): HistoryPage<Thread> {
    validateInput(input, ["limit", "after", "profileId", "ownerKind"]);
    if (
      (input.profileId !== undefined &&
        (typeof input.profileId !== "string" ||
          !/^[a-z][a-z0-9_-]{0,63}$/.test(input.profileId))) ||
      (input.ownerKind !== undefined &&
        !["operator", "task", "channel", "voice", "unresolved"].includes(
          input.ownerKind,
        ))
    )
      throw new RuntimeError("invalid", "Invalid thread history filter");
    const where: string[] = [];
    const parameters: SQLInputValue[] = [];
    if (input.profileId !== undefined) {
      where.push("json_extract(value,'$.profileId')=?");
      parameters.push(input.profileId);
    }
    if (input.ownerKind !== undefined) {
      where.push("json_extract(value,'$.owner.kind')=?");
      parameters.push(input.ownerKind);
    }
    return this.page<Thread>(
      "threads",
      input,
      JSON.stringify([
        "threads",
        input.profileId ?? null,
        input.ownerKind ?? null,
      ]),
      where,
      parameters,
    );
  }

  runs(threadId: string, input: HistoryPageInput): HistoryPage<Run> {
    validateInput(input, ["limit", "after"]);
    return this.page<Run>(
      "runs",
      input,
      JSON.stringify(["runs", threadId]),
      ["thread_id=?"],
      [threadId],
      threadId,
    );
  }

  legacyThreads() {
    const rows = this.db
      .prepare("SELECT value FROM threads ORDER BY rowid LIMIT 1001")
      .all();
    return {
      items: rows
        .slice(0, 1000)
        .map((row) => JSON.parse(String(row.value)) as Thread),
      truncated: rows.length > 1000,
    };
  }
  legacyRuns(threadId: string) {
    const rows = this.db
      .prepare(
        "SELECT value FROM runs WHERE thread_id=? ORDER BY rowid LIMIT 1001",
      )
      .all(threadId);
    return {
      items: rows
        .slice(0, 1000)
        .map((row) => JSON.parse(String(row.value)) as Run),
      truncated: rows.length > 1000,
    };
  }

  private page<T extends { createdAt: string; id: string }>(
    table: "threads" | "runs",
    input: HistoryPageInput,
    scope: string,
    where: string[],
    parameters: SQLInputValue[],
    threadId?: string,
  ): HistoryPage<T> {
    const limit = input.limit ?? 50;
    const database = String(
      this.db
        .prepare("SELECT id FROM runtime_history_identity WHERE singleton=1")
        .get()!.id,
    );
    const maximum = Number(
      this.db
        .prepare(`SELECT COALESCE(MAX(rowid),0) AS watermark FROM ${table}`)
        .get()!.watermark,
    );
    const cursor =
      input.after === undefined ? undefined : decodeCursor(input.after);
    if (cursor) {
      if (
        cursor.database !== database ||
        cursor.scope !== scope ||
        cursor.watermark > maximum
      )
        throw new RuntimeError(
          "invalid",
          "History cursor belongs to another database or query",
        );
      // Check the immutable anchor, not its mutable owner/state. Reclassification
      // removes records from the filtered result without breaking continuation.
      const anchor = this.db
        .prepare(
          `SELECT json_extract(value,'$.createdAt') AS created_at FROM ${table} WHERE id=? AND rowid<=?${table === "runs" ? " AND thread_id=?" : ""}`,
        )
        .get(
          cursor.id,
          cursor.watermark,
          ...(threadId === undefined ? [] : [threadId]),
        );
      if (!anchor || anchor.created_at !== cursor.createdAt)
        throw new RuntimeError("invalid", "Invalid history cursor anchor");
    }
    // No runtime path deletes these records. The insertion watermark excludes
    // later inserts even when the clock moves backward or timestamps tie.
    const watermark = cursor?.watermark ?? maximum;
    where.push("rowid<=?");
    parameters.push(watermark);
    if (cursor) {
      where.push("(json_extract(value,'$.createdAt'),id)<(?,?)");
      parameters.push(cursor.createdAt, cursor.id);
    }
    const rows = this.db
      .prepare(
        `SELECT value FROM ${table} WHERE ${where.join(" AND ")} ORDER BY json_extract(value,'$.createdAt') DESC,id DESC LIMIT ?`,
      )
      .all(...parameters, limit + 1);
    const items = rows
      .slice(0, limit)
      .map((row) => JSON.parse(String(row.value)) as T);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                database,
                scope,
                watermark,
                createdAt: last.createdAt,
                id: last.id,
              } satisfies Cursor),
            ).toString("base64url")
          : null,
    };
  }
}

function dataObject(
  value: unknown,
  allowed: string[],
): value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(value))
  )
    return false;
  return Reflect.ownKeys(value).every(
    (key) =>
      typeof key === "string" &&
      allowed.includes(key) &&
      "value" in Object.getOwnPropertyDescriptor(value, key)!,
  );
}
function validateInput(
  input: unknown,
  allowed: string[],
): asserts input is HistoryPageInput {
  if (
    !dataObject(input, allowed) ||
    (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) ||
        Number(input.limit) < 1 ||
        Number(input.limit) > 100)) ||
    (input.after !== undefined &&
      (typeof input.after !== "string" ||
        input.after.length < 1 ||
        input.after.length > 4096))
  )
    throw new RuntimeError("invalid", "Invalid history page input");
}
function decodeCursor(after: string): Cursor {
  const invalid = () => new RuntimeError("invalid", "Invalid history cursor");
  if (!/^[A-Za-z0-9_-]+$/.test(after)) throw invalid();
  const bytes = Buffer.from(after, "base64url");
  if (bytes.toString("base64url") !== after) throw invalid();
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw invalid();
  }
  const keys = ["version", "database", "scope", "watermark", "createdAt", "id"];
  if (
    !dataObject(value, keys) ||
    Object.keys(value).length !== keys.length ||
    value.version !== 1 ||
    typeof value.database !== "string" ||
    typeof value.scope !== "string" ||
    !Number.isSafeInteger(value.watermark) ||
    Number(value.watermark) < 1 ||
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 128 ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  )
    throw invalid();
  return value as unknown as Cursor;
}
