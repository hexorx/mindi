import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { constants, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface GitHubPushConfig {
  secretFile: string;
  repositoryIds: number[];
}
export interface GitHubPushReceipt {
  seq: number;
  observedAt: number;
  bodyHash: string;
  deliveryId: string;
  repositoryId: number;
  repository: string;
  ref: string;
  before: string;
  after: string;
  created: boolean;
  deleted: boolean;
  forced: boolean;
  sender?: { id: number; login: string };
}
export class GitHubPushError extends Error {
  constructor(
    public readonly code:
      "invalid" | "unauthorized" | "conflict" | "unavailable",
  ) {
    super("GitHub push observation " + code);
  }
}
function fail(): never {
  throw new GitHubPushError("invalid");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= max &&
    !Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  );
}
export function parseGitHubPushConfig(
  value: unknown,
  base: string,
): GitHubPushConfig | undefined {
  if (value === undefined) return undefined;
  const v = record(value);
  if (
    Object.keys(v).some((k) => !["secretFile", "repositoryIds"].includes(k)) ||
    !text(v.secretFile, 4096) ||
    !v.secretFile.trim() ||
    !Array.isArray(v.repositoryIds) ||
    !v.repositoryIds.length ||
    v.repositoryIds.length > 128 ||
    v.repositoryIds.some((id) => !positive(id)) ||
    new Set(v.repositoryIds).size !== v.repositoryIds.length
  )
    fail();
  return {
    secretFile: resolve(base, v.secretFile),
    repositoryIds: [...v.repositoryIds] as number[],
  };
}
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value);
function ref(value: unknown): value is string {
  return (
    text(value, 1024) &&
    /^refs\/(heads|tags)\/.+/.test(value) &&
    !value.includes("..") &&
    !value.endsWith(".") &&
    !value.includes("@{") &&
    !Array.from(value).some((c) => " ~^:?*\\[".includes(c)) &&
    value
      .split("/")
      .every(
        (part) => !!part && !part.startsWith(".") && !part.endsWith(".lock"),
      )
  );
}
type PushFields = Omit<
  GitHubPushReceipt,
  "seq" | "observedAt" | "bodyHash" | "deliveryId"
>;
function fields(value: Record<string, unknown>): PushFields {
  if (
    !positive(value.repositoryId) ||
    !text(value.repository, 256) ||
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(value.repository) ||
    value.repository.split("/").some((p) => p === "." || p === "..") ||
    !ref(value.ref) ||
    !sha(value.before) ||
    !sha(value.after) ||
    typeof value.created !== "boolean" ||
    typeof value.deleted !== "boolean" ||
    typeof value.forced !== "boolean"
  )
    fail();
  const zero = "0".repeat(40);
  if (
    (value.created && value.deleted) ||
    value.created !== (value.before === zero) ||
    value.deleted !== (value.after === zero)
  )
    fail();
  let sender: GitHubPushReceipt["sender"];
  if (value.sender !== undefined && value.sender !== null) {
    const s = record(value.sender);
    if (
      !positive(s.id) ||
      !text(s.login, 128) ||
      !/^[A-Za-z0-9_-]+(?:\[bot\])?$/.test(s.login)
    )
      fail();
    sender = { id: s.id, login: s.login };
  }
  return {
    repositoryId: value.repositoryId,
    repository: value.repository,
    ref: value.ref,
    before: value.before,
    after: value.after,
    created: value.created,
    deleted: value.deleted,
    forced: value.forced,
    ...(sender ? { sender } : {}),
  };
}
function payload(value: unknown): PushFields {
  const v = record(value),
    repo = record(v.repository);
  return fields({ ...v, repositoryId: repo.id, repository: repo.full_name });
}
function receipt(row: Record<string, unknown>): GitHubPushReceipt {
  const v = record(JSON.parse(String(row.receipt)));
  if (
    Object.keys(v).some(
      (k) =>
        ![
          "observedAt",
          "bodyHash",
          "deliveryId",
          "repositoryId",
          "repository",
          "ref",
          "before",
          "after",
          "created",
          "deleted",
          "forced",
          "sender",
        ].includes(k),
    ) ||
    !positive(row.seq) ||
    !positive(v.observedAt) ||
    v.observedAt > 8_640_000_000_000_000 ||
    !uuid(v.deliveryId) ||
    typeof v.bodyHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(v.bodyHash) ||
    v.bodyHash !== row.body_hash ||
    v.deliveryId !== row.delivery_id
  )
    fail();
  const push = fields(v);
  if (
    v.sender !== undefined &&
    JSON.stringify(v.sender) !== JSON.stringify(push.sender)
  )
    fail();
  return {
    seq: row.seq,
    observedAt: v.observedAt,
    bodyHash: v.bodyHash,
    deliveryId: v.deliveryId,
    ...push,
  };
}
/** Sole writer: validated signed push deliveries. No model- or operator-authored append. */
export class GitHubPushes {
  private constructor(
    private db: DatabaseSync,
    private secret: Buffer | undefined,
    private repositoryIds: Set<number>,
  ) {}
  static async open(
    path: string,
    config?: GitHubPushConfig,
  ): Promise<GitHubPushes> {
    const checked = parseGitHubPushConfig(config, ".");
    let file;
    let secret: Buffer | undefined;
    if (checked)
      try {
        file = await open(
          checked.secretFile,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const info = await file.stat();
        if (!info.isFile() || info.size > 4096) fail();
        const bytes = Buffer.alloc(4097);
        const read = await file.read(bytes, 0, bytes.length, 0);
        const value = new TextDecoder("utf-8", { fatal: true })
          .decode(bytes.subarray(0, read.bytesRead))
          .trim();
        if (
          value.length < 32 ||
          value.length > 1024 ||
          Array.from(value).some(
            (c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126,
          )
        )
          fail();
        secret = Buffer.from(value);
      } catch {
        throw new GitHubPushError("unavailable");
      } finally {
        await file?.close();
      }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path);
    try {
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS pushes(seq INTEGER PRIMARY KEY AUTOINCREMENT, body_hash TEXT NOT NULL UNIQUE, delivery_id TEXT NOT NULL UNIQUE, receipt TEXT NOT NULL) STRICT;",
      );
      return new GitHubPushes(
        db,
        secret,
        new Set(checked?.repositoryIds ?? []),
      );
    } catch (error) {
      db.close();
      secret?.fill(0);
      throw error;
    }
  }
  get enabled() {
    return this.secret !== undefined;
  }
  private verify(input: { body: Buffer; signature: string }): void {
    if (
      !this.secret ||
      !/^sha256=[0-9a-f]{64}$/.test(input.signature) ||
      input.body.length > 25 * 1024 * 1024 ||
      !timingSafeEqual(
        Buffer.from(input.signature.slice(7), "hex"),
        createHmac("sha256", this.secret).update(input.body).digest(),
      )
    )
      throw new GitHubPushError("unauthorized");
  }
  ping(input: { body: Buffer; signature: string }): void {
    this.verify(input);
    let value;
    try {
      value = record(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(input.body),
        ),
      );
    } catch {
      fail();
    }
    if (
      value.repository !== undefined &&
      !this.repositoryIds.has(record(value.repository).id as number)
    )
      throw new GitHubPushError("unauthorized");
  }
  receive(input: {
    body: Buffer;
    signature: string;
    delivery: string;
  }): GitHubPushReceipt {
    this.verify(input);
    if (!uuid(input.delivery)) fail();
    let push: PushFields;
    try {
      push = payload(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(input.body),
        ),
      );
    } catch {
      fail();
    }
    if (!this.repositoryIds.has(push.repositoryId))
      throw new GitHubPushError("unauthorized");
    const bodyHash = createHash("sha256").update(input.body).digest("hex");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const byDelivery = this.db
        .prepare("SELECT * FROM pushes WHERE delivery_id=?")
        .get(input.delivery);
      if (byDelivery && byDelivery.body_hash !== bodyHash)
        throw new GitHubPushError("conflict");
      const prior =
        byDelivery ??
        this.db.prepare("SELECT * FROM pushes WHERE body_hash=?").get(bodyHash);
      if (prior) {
        const result = receipt(prior);
        this.db.exec("COMMIT");
        return result;
      }
      const observedAt = Date.now();
      if (!positive(observedAt) || observedAt > 8_640_000_000_000_000) fail();
      const value = {
        observedAt,
        bodyHash,
        deliveryId: input.delivery,
        ...push,
      };
      const result = this.db
        .prepare(
          "INSERT INTO pushes(body_hash,delivery_id,receipt) VALUES(?,?,?)",
        )
        .run(bodyHash, input.delivery, JSON.stringify(value));
      const stored = receipt({
        seq: Number(result.lastInsertRowid),
        body_hash: bodyHash,
        delivery_id: input.delivery,
        receipt: JSON.stringify(value),
      });
      this.db.exec("COMMIT");
      return stored;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  list(
    after = 0,
    limit = 100,
  ): { items: GitHubPushReceipt[]; nextSeq: number | null } {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fail();
    const rows =
      after === 0
        ? this.db
            .prepare("SELECT * FROM pushes ORDER BY seq DESC LIMIT ?")
            .all(limit + 1)
        : this.db
            .prepare(
              "SELECT * FROM pushes WHERE seq<? ORDER BY seq DESC LIMIT ?",
            )
            .all(after, limit + 1);
    const items = rows.slice(0, limit).map(receipt);
    return { items, nextSeq: rows.length > limit ? items.at(-1)!.seq : null };
  }
  close() {
    this.secret?.fill(0);
    this.db.close();
  }
}
