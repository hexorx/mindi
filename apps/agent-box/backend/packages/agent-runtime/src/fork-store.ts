import type { DatabaseSync } from "node:sqlite";
import { RuntimeError, type ForkOperation } from "./types.js";
/** Durable identity and ownership of checkpoint-producing native work. */
export class ForkStore {
  constructor(private readonly db: DatabaseSync) {}
  migrate() {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS forks (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES threads(id), request_key TEXT UNIQUE, value TEXT NOT NULL, worker_pid INTEGER) STRICT; CREATE INDEX IF NOT EXISTS fork_parent ON forks(parent_id); PRAGMA user_version=5;`,
    );
  }
  recover() {
    this.db.exec(
      `UPDATE forks SET value=json_set(value,'$.state','attention_required') WHERE json_extract(value,'$.state')='running'`,
    );
  }
  get(id: string): ForkOperation {
    const row = this.db.prepare("SELECT value FROM forks WHERE id=?").get(id);
    if (!row) throw new RuntimeError("not_found", "Unknown fork operation");
    return JSON.parse(String(row.value)) as ForkOperation;
  }
  find(key: string): ForkOperation | undefined {
    const row = this.db
      .prepare("SELECT value FROM forks WHERE request_key=?")
      .get(key);
    return row ? (JSON.parse(String(row.value)) as ForkOperation) : undefined;
  }
  insert(op: ForkOperation, key?: string) {
    this.db
      .prepare(
        "INSERT INTO forks(id,parent_id,request_key,value) VALUES(?,?,?,?)",
      )
      .run(op.id, op.parentThreadId, key ?? null, JSON.stringify(op));
  }
  save(op: ForkOperation) {
    this.db
      .prepare("UPDATE forks SET value=? WHERE id=?")
      .run(JSON.stringify(op), op.id);
  }
  process(id: string, pid: number) {
    const old = this.pid(id);
    if (old !== undefined && old !== pid)
      throw new RuntimeError("conflict", "Fork process identity cannot change");
    this.db.prepare("UPDATE forks SET worker_pid=? WHERE id=?").run(pid, id);
  }
  pid(id: string): number | undefined {
    const row = this.db
      .prepare("SELECT worker_pid FROM forks WHERE id=?")
      .get(id);
    return row?.worker_pid == null ? undefined : Number(row.worker_pid);
  }
  unresolved(parent: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 FROM forks WHERE parent_id=? AND json_extract(value,'$.state') IN ('running','attention_required') LIMIT 1",
      )
      .get(parent);
  }
  list(parent: string, input: { after?: string; limit?: number } = {}) {
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new RuntimeError("invalid", "Invalid fork page limit");
    let after = 0;
    if (input.after !== undefined) {
      const row = this.db
        .prepare("SELECT rowid FROM forks WHERE id=? AND parent_id=?")
        .get(input.after, parent);
      if (!row) throw new RuntimeError("invalid", "Invalid fork cursor");
      after = Number(row.rowid);
    }
    const rows = this.db
      .prepare(
        "SELECT value FROM forks WHERE parent_id=? AND rowid>? ORDER BY rowid LIMIT ?",
      )
      .all(parent, after, limit + 1);
    const items = rows
      .slice(0, limit)
      .map((row) => JSON.parse(String(row.value)) as ForkOperation);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }
}
