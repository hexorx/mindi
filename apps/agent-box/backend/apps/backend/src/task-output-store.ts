import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
export interface TaskOutputScope {
  profileId: string;
  threadId: string;
  runId: string;
  taskId: string;
  attemptId: string;
}
export interface TaskOutputMetadata<Scope = TaskOutputScope> {
  id: string;
  scope: Scope;
  name: string;
  size: number;
  sha256: string;
  mediaType: string;
}
const MAX_FILE = 4 * 1024 * 1024,
  MAX_TOTAL = 16 * 1024 * 1024;
function invalid(): never {
  throw Error("Invalid task output acquisition");
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    value.length <= max &&
    !Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  );
}
export function taskOutputScope(value: TaskOutputScope): TaskOutputScope {
  const keys = [
    "profileId",
    "threadId",
    "runId",
    "taskId",
    "attemptId",
  ] as const;
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys)
    if (
      !descriptors[key] ||
      !("value" in descriptors[key]!) ||
      !text(descriptors[key]!.value, 200)
    )
      invalid();
  return Object.fromEntries(
    keys.map((key) => [key, value[key]]),
  ) as unknown as TaskOutputScope;
}
function pathsOf(value: readonly string[]): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 16 ||
    new Set(value).size !== value.length
  )
    invalid();
  return value.map((path) => {
    if (!text(path, 2048) || path.includes("\\") || path.includes(":"))
      invalid();
    const parts = path.split("/");
    if (
      parts.some(
        (p) => !p || p === "." || p === ".." || Buffer.byteLength(p) > 255,
      )
    )
      invalid();
    return path;
  });
}
function digest(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
/** Durable acquisition boundary. The application must validate authoritative run
 * lineage and provide confined capture from that run's pinned export root. This
 * store never treats a supplied profile label or arbitrary pathname as authority. */
export class TaskOutputStore<
  Scope extends { runId: string } = TaskOutputScope,
> {
  private readonly db: DatabaseSync;
  private closed = false;
  private closing?: Promise<void>;
  private readonly pending = new Map<
    string,
    { identity: string; promise: Promise<TaskOutputMetadata<Scope>[]> }
  >();
  constructor(
    private readonly options: {
      databasePath: string;
      normalizeScope?(scope: Scope): Scope;
      validateScope(scope: Scope): void;
      capture(scope: Scope, parts: readonly string[]): Promise<Buffer>;
    },
  ) {
    this.db = new DatabaseSync(options.databasePath);
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS output_reports(run_id TEXT PRIMARY KEY,scope TEXT NOT NULL,paths TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('acquiring','completed','attention'))) STRICT; CREATE TABLE IF NOT EXISTS task_outputs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,ordinal INTEGER NOT NULL,metadata TEXT NOT NULL,bytes BLOB NOT NULL,UNIQUE(run_id,ordinal)) STRICT;",
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private check(scope: Scope) {
    if (this.closed) throw Error("Task output store is closed");
    const normalized = this.options.normalizeScope
      ? this.options.normalizeScope(scope)
      : (taskOutputScope(
          scope as unknown as TaskOutputScope,
        ) as unknown as Scope);
    this.options.validateScope(structuredClone(normalized));
    return normalized;
  }
  async acquire(
    input: Scope,
    requested: readonly string[],
  ): Promise<TaskOutputMetadata<Scope>[]> {
    const scope = this.check(input),
      paths = pathsOf(requested),
      identity = JSON.stringify([scope, paths]);
    const active = this.pending.get(scope.runId);
    if (active) {
      if (active.identity !== identity)
        throw Error("Task output report conflict");
      return structuredClone(await active.promise);
    }
    const operation = this.capture(scope, paths);
    this.pending.set(scope.runId, { identity, promise: operation });
    try {
      return structuredClone(await operation);
    } finally {
      this.pending.delete(scope.runId);
    }
  }
  private async capture(
    scope: Scope,
    paths: string[],
  ): Promise<TaskOutputMetadata<Scope>[]> {
    const owner = JSON.stringify(scope),
      names = JSON.stringify(paths);
    const prior = this.db
      .prepare("SELECT scope,paths,state FROM output_reports WHERE run_id=?")
      .get(scope.runId);
    if (prior) {
      if (prior.scope !== owner || prior.paths !== names)
        throw Error("Task output report conflict");
      if (prior.state !== "completed")
        throw Error("Task output acquisition requires attention");
      return this.manifest(scope, paths);
    }
    this.db
      .prepare("INSERT INTO output_reports VALUES(?,?,?,'acquiring')")
      .run(scope.runId, owner, names);
    const outputs: { metadata: TaskOutputMetadata<Scope>; bytes: Buffer }[] =
      [];
    let total = 0;
    try {
      for (const path of paths) {
        const captured = await this.options.capture(
          structuredClone(scope),
          path.split("/"),
        );
        if (
          !Buffer.isBuffer(captured) ||
          captured.length > MAX_FILE ||
          total + captured.length > MAX_TOTAL
        )
          invalid();
        const bytes = Buffer.from(captured);
        total += bytes.length;
        outputs.push({
          bytes,
          metadata: {
            id: randomUUID(),
            scope: structuredClone(scope),
            name: path.split("/").at(-1)!,
            size: bytes.length,
            sha256: digest(bytes),
            mediaType: "application/octet-stream",
          },
        });
      }
      this.options.validateScope(structuredClone(scope));
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const current = this.db
          .prepare(
            "SELECT scope,paths,state FROM output_reports WHERE run_id=?",
          )
          .get(scope.runId);
        if (
          current?.state !== "acquiring" ||
          current.scope !== owner ||
          current.paths !== names
        )
          throw Error("Task output report conflict");
        outputs.forEach(({ metadata, bytes }, ordinal) =>
          this.db
            .prepare("INSERT INTO task_outputs VALUES(?,?,?,?,?)")
            .run(
              metadata.id,
              scope.runId,
              ordinal,
              JSON.stringify(metadata),
              bytes,
            ),
        );
        this.db
          .prepare("UPDATE output_reports SET state='completed' WHERE run_id=?")
          .run(scope.runId);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return outputs.map((output) => output.metadata);
    } catch {
      this.db
        .prepare(
          "UPDATE output_reports SET state='attention' WHERE run_id=? AND state='acquiring'",
        )
        .run(scope.runId);
      throw Error("Task output acquisition requires attention");
    }
  }
  private verified(
    row: Record<string, unknown>,
    scope: Scope,
  ): { metadata: TaskOutputMetadata<Scope>; bytes: Buffer } {
    try {
      const metadata = JSON.parse(
        String(row.metadata),
      ) as TaskOutputMetadata<Scope>;
      const bytes = Buffer.from(row.bytes as Uint8Array);
      if (
        metadata.id !== row.id ||
        JSON.stringify(metadata.scope) !== JSON.stringify(scope) ||
        !text(metadata.name, 255) ||
        /[\\/]/.test(metadata.name) ||
        metadata.mediaType !== "application/octet-stream" ||
        bytes.length > MAX_FILE ||
        metadata.size !== bytes.length ||
        metadata.sha256 !== digest(bytes)
      )
        throw Error();
      return { metadata, bytes };
    } catch {
      throw Error("Task output integrity verification failed");
    }
  }
  private manifest(scope: Scope, paths: string[]): TaskOutputMetadata<Scope>[] {
    const rows = this.db
      .prepare(
        "SELECT id,ordinal,metadata,bytes FROM task_outputs WHERE run_id=? ORDER BY ordinal",
      )
      .all(scope.runId);
    if (rows.length !== paths.length)
      throw Error("Task output integrity verification failed");
    let total = 0;
    return rows.map((row, index) => {
      const { metadata, bytes } = this.verified(row, scope);
      total += bytes.length;
      if (
        row.ordinal !== index ||
        metadata.name !== paths[index]!.split("/").at(-1) ||
        total > MAX_TOTAL
      )
        throw Error("Task output integrity verification failed");
      return metadata;
    });
  }
  content(
    input: Scope,
    id: string,
  ): { metadata: TaskOutputMetadata<Scope>; bytes: Buffer } {
    const scope = this.check(input);
    if (!text(id, 200)) invalid();
    const report = this.db
      .prepare("SELECT scope,paths,state FROM output_reports WHERE run_id=?")
      .get(scope.runId);
    if (report?.state !== "completed" || report.scope !== JSON.stringify(scope))
      throw Error("Task output unavailable for run");
    try {
      this.manifest(scope, pathsOf(JSON.parse(String(report.paths))));
    } catch {
      throw Error("Task output integrity verification failed");
    }
    const row = this.db
      .prepare(
        "SELECT id,metadata,bytes FROM task_outputs WHERE id=? AND run_id=?",
      )
      .get(id, scope.runId);
    if (!row) throw Error("Task output unavailable for run");
    return this.verified(row, scope);
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      await Promise.allSettled(
        [...this.pending.values()].map((item) => item.promise),
      );
      this.db.close();
    })();
    return this.closing;
  }
}
