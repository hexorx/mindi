import {
  constants,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ArtifactWorkspace } from "./artifact-workspace.js";
import { taskOutputScope, type TaskOutputScope } from "./task-output-store.js";
/** Run export directories are acquisition boundaries, not worker sandboxes. */
export class TaskOutputExports<
  Scope extends { runId: string } = TaskOutputScope,
> {
  private readonly db: DatabaseSync;
  private readonly root: string;
  private readonly fd: number;
  private readonly identity: { dev: bigint; ino: bigint };
  private closed = false;
  private closing?: Promise<void>;
  private readonly pending = new Set<Promise<Buffer>>();
  constructor(
    private readonly options: {
      databasePath: string;
      normalizeScope?(scope: Scope): Scope;
      exportRoot: string;
      validateScope(scope: Scope): void;
    },
  ) {
    if (process.platform !== "linux")
      throw Error(
        "Run output capture requires Linux descriptor-relative filesystem access",
      );
    this.root = resolve(options.exportRoot);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (realpathSync(this.root) !== this.root)
      throw Error("Invalid run export root");
    const before = lstatSync(this.root, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink())
      throw Error("Invalid run export root");
    this.fd = openSync(
      this.root,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      this.identity = fstatSync(this.fd, { bigint: true });
      this.verifyRoot();
      if (this.identity.dev !== before.dev || this.identity.ino !== before.ino)
        throw Error("Run export root changed");
      this.db = new DatabaseSync(options.databasePath);
    } catch (error) {
      closeSync(this.fd);
      throw error;
    }
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS run_exports(run_id TEXT PRIMARY KEY,scope TEXT NOT NULL,directory TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('preparing','ready','attention')),dev TEXT,ino TEXT) STRICT;",
      );
    } catch (error) {
      this.db.close();
      closeSync(this.fd);
      throw error;
    }
  }
  private verifyRoot() {
    const current = lstatSync(this.root, { bigint: true });
    if (
      !current.isDirectory() ||
      current.dev !== this.identity.dev ||
      current.ino !== this.identity.ino ||
      realpathSync(this.root) !== this.root
    )
      throw Error("Run export root changed");
  }
  private check(input: Scope) {
    if (this.closed) throw Error("Run exports are closed");
    const scope = this.options.normalizeScope
      ? this.options.normalizeScope(input)
      : (taskOutputScope(
          input as unknown as TaskOutputScope,
        ) as unknown as Scope);
    this.options.validateScope(structuredClone(scope));
    this.verifyRoot();
    return scope;
  }
  private row(scope: Scope) {
    const row = this.db
      .prepare("SELECT * FROM run_exports WHERE run_id=?")
      .get(scope.runId);
    if (
      !row ||
      row.scope !== JSON.stringify(scope) ||
      row.state !== "ready" ||
      typeof row.directory !== "string" ||
      !/^\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        row.directory,
      ) ||
      typeof row.dev !== "string" ||
      typeof row.ino !== "string"
    )
      throw Error("Run export ownership requires attention");
    return { directory: row.directory, dev: row.dev, ino: row.ino };
  }
  private workspace(scope: Scope) {
    const row = this.row(scope),
      path = join(this.root, row.directory);
    const workspace = new ArtifactWorkspace(path, {
      dev: row.dev,
      ino: row.ino,
    });
    if (workspace.unavailable) {
      workspace.close();
      throw Error("Run export ownership requires attention");
    }
    return { path, workspace };
  }
  prepare(input: Scope): string {
    const scope = this.check(input),
      prior = this.db
        .prepare("SELECT run_id FROM run_exports WHERE run_id=?")
        .get(scope.runId);
    if (prior) {
      const { path, workspace } = this.workspace(scope);
      workspace.close();
      return path;
    }
    const directory = randomUUID();
    this.db
      .prepare("INSERT INTO run_exports VALUES(?,?,?,'preparing',NULL,NULL)")
      .run(scope.runId, JSON.stringify(scope), directory);
    try {
      mkdirSync(`/proc/self/fd/${this.fd}/${directory}`, { mode: 0o700 });
      const child = openSync(
        `/proc/self/fd/${this.fd}/${directory}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      let identity;
      try {
        identity = fstatSync(child, { bigint: true });
      } finally {
        closeSync(child);
      }
      this.verifyRoot();
      this.options.validateScope(structuredClone(scope));
      this.db
        .prepare(
          "UPDATE run_exports SET state='ready',dev=?,ino=? WHERE run_id=?",
        )
        .run(String(identity.dev), String(identity.ino), scope.runId);
      const { path, workspace } = this.workspace(scope);
      workspace.close();
      return path;
    } catch {
      this.db
        .prepare("UPDATE run_exports SET state='attention' WHERE run_id=?")
        .run(scope.runId);
      throw Error("Run export preparation requires attention");
    }
  }
  capture(input: Scope, parts: readonly string[]): Promise<Buffer> {
    const operation = this.read(input, parts);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  private async read(input: Scope, parts: readonly string[]) {
    const scope = this.check(input);
    if (
      !Array.isArray(parts) ||
      !parts.length ||
      parts.join("/").length > 2048 ||
      parts.some(
        (p) =>
          typeof p !== "string" ||
          !p ||
          p === "." ||
          p === ".." ||
          /[\\/:]/.test(p) ||
          Buffer.byteLength(p) > 255 ||
          Array.from(p).some(
            (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
          ),
      )
    )
      throw Error("Invalid run output path");
    const { workspace } = this.workspace(scope);
    try {
      const bytes = await workspace.capture([...parts]);
      this.verifyRoot();
      this.options.validateScope(structuredClone(scope));
      return bytes;
    } finally {
      workspace.close();
    }
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      await Promise.allSettled([...this.pending]);
      try {
        this.db.close();
      } finally {
        closeSync(this.fd);
      }
    })();
    return this.closing;
  }
}
