import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { extname } from "node:path";
import { ArtifactWorkspace, MAX_ARTIFACT_BYTES } from "./artifact-workspace.js";
export class ArtifactError extends Error {
  constructor(
    readonly code:
      "invalid" | "not_found" | "conflict" | "unavailable" | "closed",
    message: string,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}
export interface ArtifactMetadata {
  id: string;
  profileId: string;
  sourcePath: string;
  workspaceScope: "shared";
  name: string;
  mediaType: string;
  size: number;
  sha256: string;
  acquiredAt: string;
  acquiredBy: "operator";
}
function string(value: unknown, name: string, max: number) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new ArtifactError("invalid", `Invalid ${name}.`);
  return value;
}
function relativePath(value: unknown) {
  const path = string(value, "relative artifact path", 2048);
  const parts = path.split("/");
  if (
    path.includes("\\") ||
    path.includes(":") ||
    parts.some((p) => !p || p === "." || p === ".." || p.length > 255)
  )
    throw new ArtifactError(
      "invalid",
      "Choose a confined relative artifact path.",
    );
  return { path, parts };
}
function media(name: string) {
  return (
    (
      {
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".csv": "text/csv",
        ".json": "application/json",
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
      } as Record<string, string>
    )[extname(name).toLowerCase()] || "application/octet-stream"
  );
}
/** Operator snapshots. Profile IDs are provenance, not separate workspace authority. */
export class ArtifactStore {
  private readonly db: DatabaseSync;
  private readonly workspace: ArtifactWorkspace;
  private closed = false;
  private closing?: Promise<void>;
  private readonly pending = new Set<Promise<ArtifactMetadata>>();
  constructor(
    private readonly options: {
      databasePath: string;
      workspace: string;
      validateProfile(id: string): void;
    },
  ) {
    this.workspace = new ArtifactWorkspace(options.workspace);
    let database: DatabaseSync | undefined;
    try {
      this.db = database = new DatabaseSync(options.databasePath);
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS artifacts(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,profile_id TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,input TEXT NOT NULL,metadata TEXT NOT NULL CHECK(json_valid(metadata)),bytes BLOB NOT NULL) STRICT;",
      );
    } catch (error) {
      database?.close();
      this.workspace.close();
      throw error;
    }
  }
  private check(profileId: string) {
    if (this.closed)
      throw new ArtifactError("closed", "Artifact store is closed.");
    string(profileId, "profile", 64);
    this.options.validateProfile(profileId);
  }
  capability(profileId: string) {
    this.check(profileId);
    return {
      version: 1,
      workspaceScope: "shared" as const,
      maxBytes: MAX_ARTIFACT_BYTES,
      acquisition: {
        available: !this.workspace.unavailable,
        ...(this.workspace.unavailable
          ? { reason: this.workspace.unavailable }
          : {}),
      },
    };
  }
  private prior(key: string, input: string): ArtifactMetadata | undefined {
    const row = this.db
      .prepare("SELECT input,metadata FROM artifacts WHERE request_key=?")
      .get(key);
    if (!row) return undefined;
    if (row.input !== input)
      throw new ArtifactError("conflict", "Artifact acquisition key conflict.");
    return JSON.parse(String(row.metadata)) as ArtifactMetadata;
  }
  acquire(input: {
    profileId: string;
    path: string;
    idempotencyKey: string;
  }): Promise<ArtifactMetadata> {
    const operation = this.capture(input);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  private async capture(input: {
    profileId: string;
    path: string;
    idempotencyKey: string;
  }) {
    this.check(input.profileId);
    const { path, parts } = relativePath(input.path),
      key = string(input.idempotencyKey, "acquisition key", 200),
      identity = JSON.stringify([input.profileId, path]);
    const prior = this.prior(key, identity);
    if (prior) return prior;
    if (this.workspace.unavailable)
      throw new ArtifactError("unavailable", this.workspace.unavailable);
    let bytes: Buffer;
    try {
      bytes = await this.workspace.capture(parts);
    } catch {
      throw new ArtifactError(
        "invalid",
        "Workspace file is unavailable, unsafe, oversized, or changed during acquisition.",
      );
    }
    this.check(input.profileId);
    const name = parts.at(-1)!;
    const metadata: ArtifactMetadata = {
      id: randomUUID(),
      profileId: input.profileId,
      sourcePath: path,
      workspaceScope: "shared",
      name,
      mediaType: media(name),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      acquiredAt: new Date().toISOString(),
      acquiredBy: "operator",
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.prior(key, identity);
      if (existing) {
        this.db.exec("COMMIT");
        return existing;
      }
      this.db
        .prepare(
          "INSERT INTO artifacts(id,profile_id,request_key,input,metadata,bytes) VALUES(?,?,?,?,?,?)",
        )
        .run(
          metadata.id,
          input.profileId,
          key,
          identity,
          JSON.stringify(metadata),
          bytes,
        );
      this.db.exec("COMMIT");
      return metadata;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  list(profileId: string, input: { after?: string; limit?: number } = {}) {
    this.check(profileId);
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new ArtifactError("invalid", "Invalid artifact page size.");
    let after = 0;
    if (input.after !== undefined) {
      try {
        const cursor = string(input.after, "artifact cursor", 1000);
        if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
        const parsed = JSON.parse(
          Buffer.from(cursor, "base64url").toString("utf8"),
        ) as unknown;
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 2 ||
          parsed[0] !== profileId ||
          !Number.isSafeInteger(parsed[1]) ||
          Number(parsed[1]) < 1
        )
          throw Error();
        after = Number(parsed[1]);
      } catch {
        throw new ArtifactError(
          "invalid",
          "Invalid profile-scoped artifact cursor.",
        );
      }
    }
    const rows = this.db
      .prepare(
        "SELECT seq,metadata FROM artifacts WHERE profile_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(profileId, after, limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map(
        (r) => JSON.parse(String(r.metadata)) as ArtifactMetadata,
      ),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify([profileId, Number(page.at(-1)!.seq)]),
            ).toString("base64url")
          : null,
    };
  }
  get(profileId: string, id: string): ArtifactMetadata {
    this.check(profileId);
    string(id, "artifact ID", 200);
    const row = this.db
      .prepare("SELECT metadata FROM artifacts WHERE profile_id=? AND id=?")
      .get(profileId, id);
    if (!row)
      throw new ArtifactError(
        "not_found",
        "Artifact not found for this profile.",
      );
    return JSON.parse(String(row.metadata)) as ArtifactMetadata;
  }
  content(profileId: string, id: string) {
    const artifact = this.get(profileId, id);
    const row = this.db
      .prepare("SELECT bytes FROM artifacts WHERE profile_id=? AND id=?")
      .get(profileId, id)!;
    const bytes = Buffer.from(row.bytes as Uint8Array);
    if (
      bytes.length > MAX_ARTIFACT_BYTES ||
      bytes.length !== artifact.size ||
      createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
    )
      throw new ArtifactError(
        "unavailable",
        "Stored artifact integrity verification failed.",
      );
    return { artifact, base64: bytes.toString("base64") };
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closed = true;
      await Promise.allSettled([...this.pending]);
      try {
        this.db.close();
      } finally {
        this.workspace.close();
      }
    })();
    return this.closing;
  }
}
