import type { DatabaseSync } from "node:sqlite";
import {
  RuntimeError,
  type Interaction,
  type Thread,
  type ThreadOwner,
} from "./types.js";

export interface InteractionReceipt {
  seq: number;
  at: number | null;
  origin: "transition" | "legacy_snapshot";
  context: { threadId: string; profileId: string; owner: ThreadOwner };
  interaction: Interaction;
}
export interface InteractionHistoryInput {
  limit?: number;
  after?: string;
}
interface Cursor {
  version: 1;
  database: string;
  scope: "interaction-history";
  before: number;
  watermark: number;
}

/** Immutable observations. A historical pending receipt is not evidence of a current need. */
export class InteractionHistory {
  constructor(private readonly db: DatabaseSync) {}
  migrate(legacy: boolean): void {
    if (
      !legacy &&
      !this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='interaction_history'",
        )
        .get()
    )
      throw new RuntimeError("unavailable", "Interaction history is missing");
    this.db.exec(`CREATE TABLE IF NOT EXISTS interaction_history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      interaction_id TEXT NOT NULL REFERENCES interactions(id),
      value TEXT NOT NULL
    ) STRICT; CREATE INDEX IF NOT EXISTS interaction_history_item ON interaction_history(interaction_id,seq);`);
    if (!legacy) return;
    let after = 0;
    while (true) {
      const rows = this.db
        .prepare(
          `SELECT i.rowid AS seq,i.value FROM interactions i
        WHERE i.rowid>? AND NOT EXISTS(SELECT 1 FROM interaction_history h WHERE h.interaction_id=i.id)
        ORDER BY i.rowid LIMIT 100`,
        )
        .all(after);
      if (!rows.length) break;
      for (const row of rows) {
        this.append(JSON.parse(String(row.value)) as Interaction, true);
        after = Number(row.seq);
      }
    }
  }
  /** Caller owns the same transaction as state and replay event persistence. */
  append(interaction: Interaction, legacy = false): void {
    const first = this.db
      .prepare(
        "SELECT value FROM interaction_history WHERE interaction_id=? ORDER BY seq LIMIT 1",
      )
      .get(interaction.id);
    let context: InteractionReceipt["context"];
    if (first)
      context = (JSON.parse(String(first.value)) as InteractionReceipt).context;
    else {
      const row = this.db
        .prepare(
          "SELECT t.value FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=?",
        )
        .get(interaction.runId);
      if (!row)
        throw new RuntimeError("unavailable", "Interaction owner unavailable");
      const thread = JSON.parse(String(row.value)) as Thread;
      context = {
        threadId: thread.id,
        profileId: thread.profileId,
        owner: legacy
          ? { kind: "unresolved" }
          : (thread.owner ?? { kind: "unresolved" }),
      };
    }
    const receipt: Omit<InteractionReceipt, "seq"> = {
      at: legacy ? null : Date.now(),
      origin: legacy ? "legacy_snapshot" : "transition",
      context,
      interaction,
    };
    this.db
      .prepare(
        "INSERT INTO interaction_history(interaction_id,value) VALUES(?,?)",
      )
      .run(interaction.id, JSON.stringify(receipt));
  }
  current(): {
    observedAt: number;
    total: number;
    items: InteractionReceipt[];
  } {
    const total = Number(
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM interactions WHERE json_extract(value,'$.state')='pending'",
        )
        .get()!.n,
    );
    const rows = this.db
      .prepare(
        `SELECT h.seq,h.value FROM interactions i JOIN interaction_history h
      ON h.seq=(SELECT MAX(seq) FROM interaction_history WHERE interaction_id=i.id)
      WHERE json_extract(i.value,'$.state')='pending' ORDER BY h.seq DESC LIMIT 100`,
      )
      .all();
    return {
      observedAt: Date.now(),
      total,
      items: rows.map(
        (row) =>
          ({
            ...JSON.parse(String(row.value)),
            seq: Number(row.seq),
          }) as InteractionReceipt,
      ),
    };
  }
  page(input: InteractionHistoryInput = {}): {
    items: InteractionReceipt[];
    nextCursor: string | null;
  } {
    const invalid = () =>
      new RuntimeError("invalid", "Invalid interaction history page");
    const limit = input?.limit ?? 50;
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some((key) => key !== "limit" && key !== "after") ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw invalid();
    const database = String(
      this.db
        .prepare("SELECT id FROM runtime_history_identity WHERE singleton=1")
        .get()!.id,
    );
    const maximum = Number(
      this.db
        .prepare("SELECT COALESCE(MAX(seq),0) AS n FROM interaction_history")
        .get()!.n,
    );
    if (!Number.isSafeInteger(maximum) || maximum < 0)
      throw new RuntimeError(
        "unavailable",
        "Interaction history sequence unavailable",
      );
    let watermark = maximum;
    let before: number | undefined;
    if (input.after !== undefined) {
      try {
        if (
          typeof input.after !== "string" ||
          input.after.length > 1000 ||
          !/^[A-Za-z0-9_-]+$/.test(input.after)
        )
          throw invalid();
        const bytes = Buffer.from(input.after, "base64url");
        if (bytes.toString("base64url") !== input.after) throw invalid();
        const c = JSON.parse(bytes.toString()) as Cursor;
        if (
          !c ||
          Object.keys(c).sort().join(",") !==
            "before,database,scope,version,watermark" ||
          c.version !== 1 ||
          c.database !== database ||
          c.scope !== "interaction-history" ||
          !Number.isSafeInteger(c.before) ||
          !Number.isSafeInteger(c.watermark) ||
          c.before < 1 ||
          c.before > c.watermark ||
          c.watermark > maximum
        )
          throw invalid();
        before = c.before;
        watermark = c.watermark;
      } catch {
        throw invalid();
      }
    }
    const rows = this.db
      .prepare(
        `SELECT seq,value FROM interaction_history WHERE seq<=? ${before === undefined ? "" : "AND seq<?"} ORDER BY seq DESC LIMIT ?`,
      )
      .all(watermark, ...(before === undefined ? [] : [before]), limit + 1);
    const items = rows.slice(0, limit).map(
      (row) =>
        ({
          ...JSON.parse(String(row.value)),
          seq: Number(row.seq),
        }) as InteractionReceipt,
    );
    return {
      items,
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify({
                version: 1,
                database,
                scope: "interaction-history",
                before: items.at(-1)!.seq,
                watermark,
              } satisfies Cursor),
            ).toString("base64url")
          : null,
    };
  }
}
