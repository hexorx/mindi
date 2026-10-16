import { isDeepStrictEqual } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { extname } from "node:path";
import {
  RuntimeError,
  type AgentRuntime,
  type Thread,
  type AttachmentScope,
  type AttachmentMetadata,
  type ResolvedAttachment,
} from "@mindi/agent-runtime";
import type {
  MessagingStore,
  AgentAttachmentForwarder,
  ChannelAttachmentScope,
  ExternalProvenance,
  ExternalAttachmentMetadata,
} from "@mindi/messaging";
export const MAX_ATTACHMENT_BYTES = 3_000_000;
function invalid(message: string): never {
  throw new RuntimeError("invalid", message);
}
function identity(value: unknown, label: string, max = 1024): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > max ||
    /\s/.test(value) ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    invalid(`Invalid ${label}`);
  return value;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    invalid("Unexpected attachment fields");
  return value as Record<string, unknown>;
}
function media(name: string, bytes: Buffer): string {
  const ext = extname(name).toLowerCase();
  let detected: string | undefined;
  if (
    bytes.length >= 24 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  )
    detected = "image/png";
  else if (
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    detected = "image/jpeg";
  else if (
    bytes.length >= 10 &&
    /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))
  )
    detected = "image/gif";
  else if (
    bytes.length >= 16 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    detected = "image/webp";
  else if (bytes.length >= 26 && bytes.toString("ascii", 0, 2) === "BM")
    detected = "image/bmp";
  else if (/^%PDF-[12]\.\d/.test(bytes.toString("ascii", 0, 8)))
    detected = "application/pdf";
  const expected: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".pdf": "application/pdf",
  };
  if (expected[ext] && expected[ext] !== detected)
    invalid("Attachment image/PDF signature mismatch");
  return (
    detected ||
    (
      {
        ".txt": "text/plain",
        ".md": "text/markdown",
        ".csv": "text/csv",
        ".json": "application/json",
      } as Record<string, string>
    )[ext] ||
    "application/octet-stream"
  );
}
/** Immutable inbound bytes. Scope grants submission authority, never a client path. */
export class AttachmentStore {
  private readonly db: DatabaseSync;
  constructor(
    private readonly options: {
      databasePath: string;
      runtime: AgentRuntime;
      messaging: () => MessagingStore | undefined;
    },
  ) {
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,request_key TEXT NOT NULL UNIQUE,input TEXT NOT NULL,metadata TEXT NOT NULL CHECK(json_valid(metadata)),bytes BLOB NOT NULL) STRICT;",
    );
  }
  private scope(value: unknown): AttachmentScope {
    const row = object(value, [
      "kind",
      "threadId",
      "profileId",
      "channelId",
      "branchId",
    ]);
    const profileId = identity(row.profileId, "profile");
    this.options.runtime.getProfile(profileId);
    if (row.kind === "thread") {
      if (row.channelId !== undefined || row.branchId !== undefined)
        invalid("Invalid thread attachment scope");
      const threadId = identity(row.threadId, "thread"),
        thread = this.options.runtime.getThread(threadId);
      if (thread.profileId !== profileId || thread.owner?.kind !== "operator")
        throw new RuntimeError("conflict", "Attachment thread scope mismatch");
      return { kind: "thread", threadId, profileId };
    }
    if (row.kind !== "channel" || row.threadId !== undefined)
      invalid("Invalid attachment scope");
    const channelId = identity(row.channelId, "channel"),
      store = this.options.messaging();
    if (!store)
      throw new RuntimeError("unavailable", "Channel attachments unavailable");
    const channel = store.getChannel(channelId);
    if (!channel.members.includes(`agent:${profileId}`))
      throw new RuntimeError(
        "conflict",
        "Attachment recipient is not a channel member",
      );
    const branchId =
      row.branchId === undefined ? undefined : identity(row.branchId, "branch");
    if (branchId && store.getBranch(branchId).channelId !== channelId)
      throw new RuntimeError("conflict", "Attachment branch scope mismatch");
    return {
      kind: "channel",
      channelId,
      profileId,
      ...(branchId ? { branchId } : {}),
    };
  }
  stage(value: unknown): AttachmentMetadata {
    return this.stageRecord(value);
  }
  /** Trusted run capability: callers cannot turn arbitrary stored file IDs into recipient grants. */
  forward(input: Parameters<AgentAttachmentForwarder>[0]) {
    const run = this.options.runtime.getRun(input.runId);
    const thread = this.options.runtime.getThread(run.threadId);
    if (
      run.id !== input.runId ||
      run.state !== "running" ||
      thread.profileId !== input.profileId
    )
      throw new RuntimeError(
        "conflict",
        "Attachment forwarding requires the active source run",
      );
    if (
      !Array.isArray(input.attachmentIds) ||
      !input.attachmentIds.length ||
      input.attachmentIds.length > 16 ||
      new Set(input.attachmentIds).size !== input.attachmentIds.length
    )
      invalid("Invalid forwarded attachment IDs");
    const scope = this.scope(input.scope);
    if (
      scope.kind !== "channel" ||
      scope.profileId === input.profileId ||
      !this.options
        .messaging()!
        .getChannel(scope.channelId)
        .members.includes(`agent:${input.profileId}`)
    )
      throw new RuntimeError(
        "conflict",
        "Attachment forwarding destination mismatch",
      );
    const admitted = run.workerAttachmentMetadata ?? run.attachments ?? [];
    const files = input.attachmentIds.map((id) => {
      identity(id, "attachment", 128);
      const expected =
        admitted.find((file) => file.id === id) ??
        this.options.runtime.resolveHistoricalAttachment(run.id, id);
      if (!expected || expected.scope.profileId !== input.profileId)
        throw new RuntimeError(
          "conflict",
          "Attachment is not admitted to the source run",
        );
      const actual = this.record(id);
      const fields = [
        "id",
        "name",
        "mediaType",
        "size",
        "sha256",
        "createdAt",
      ] as const;
      if (
        fields.some((key) => expected[key] !== actual.metadata[key]) ||
        !isDeepStrictEqual(expected.scope, actual.metadata.scope)
      )
        throw new RuntimeError(
          "conflict",
          "Forwarded attachment identity changed",
        );
      return actual;
    });
    identity(input.idempotencyKey, "forwarding key", 1024);
    return files.map(({ metadata, data }) => {
      const copy = this.stageRecord(
        {
          scope,
          name: metadata.name,
          data,
          idempotencyKey:
            "forward:" +
            createHash("sha256")
              .update(
                JSON.stringify([
                  input.runId,
                  input.idempotencyKey,
                  metadata.id,
                ]),
              )
              .digest("hex"),
        },
        undefined,
        true,
      );
      return { ...copy, scope };
    });
  }
  /** Trusted connector byte admission. Ordinary upload routes cannot supply provenance. */
  stageExternal(value: {
    scope: ChannelAttachmentScope;
    provenance: ExternalProvenance;
    name: string;
    data: string;
    idempotencyKey: string;
  }): ExternalAttachmentMetadata {
    const row = object(value, [
      "scope",
      "provenance",
      "name",
      "data",
      "idempotencyKey",
    ]);
    const messaging = this.options.messaging();
    if (!messaging)
      throw new RuntimeError(
        "unavailable",
        "External attachment admission unavailable",
      );
    const provenance = messaging.assertExternalAttachmentScope(
      value.scope,
      value.provenance,
    );
    return this.stageRecord(
      {
        scope: row.scope,
        name: row.name,
        data: row.data,
        idempotencyKey: row.idempotencyKey,
      },
      provenance,
    ) as ExternalAttachmentMetadata;
  }
  resolveExternal(
    scope: ChannelAttachmentScope,
    provenance: ExternalProvenance,
    ids: string[],
  ): ExternalAttachmentMetadata[] {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 16 ||
      new Set(ids).size !== ids.length
    )
      invalid("Invalid external attachment IDs");
    let total = 0;
    return ids.map((id) => {
      const { metadata } = this.externalContent(scope, provenance, id);
      total += metadata.size;
      if (total > 24 * 1024 * 1024)
        invalid("External attachment aggregate limit exceeded");
      return metadata;
    });
  }
  externalContent(
    scope: ChannelAttachmentScope,
    input: ExternalProvenance,
    id: string,
  ): { metadata: ExternalAttachmentMetadata; data: string } {
    const messaging = this.options.messaging();
    if (!messaging)
      throw new RuntimeError(
        "unavailable",
        "External attachment admission unavailable",
      );
    const provenance = messaging.assertExternalAttachmentScope(scope, input);
    const record = this.record(id),
      metadata = record.metadata as ExternalAttachmentMetadata;
    if (
      metadata.scope.kind !== "channel" ||
      metadata.scope.channelId !== scope.channelId ||
      metadata.scope.profileId !== scope.profileId ||
      (metadata.scope.branchId ?? null) !== (scope.branchId ?? null) ||
      JSON.stringify(metadata.external) !== JSON.stringify(provenance)
    )
      throw new RuntimeError("conflict", "External attachment scope mismatch");
    return { ...record, metadata };
  }
  private stageRecord(
    value: unknown,
    external?: ExternalProvenance,
    allowEmpty = false,
  ): AttachmentMetadata {
    const row = object(value, ["scope", "name", "data", "idempotencyKey"]),
      scope = this.scope(row.scope),
      key =
        (external ? "external:" : "") +
        identity(row.idempotencyKey, "staging key", 128);
    const name = row.name;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 255 ||
      Buffer.byteLength(name) > 1024 ||
      /[\\/]/.test(name) ||
      Array.from(name).some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      )
    )
      invalid("Invalid attachment filename");
    if (
      typeof row.data !== "string" ||
      (!external && !allowEmpty && !row.data) ||
      row.data.length > 4_000_000
    )
      invalid("Attachment exceeds byte limit or is empty");
    const bytes = Buffer.from(row.data, "base64");
    if (
      (!external && !allowEmpty && !bytes.length) ||
      bytes.length > MAX_ATTACHMENT_BYTES ||
      bytes.toString("base64") !== row.data
    )
      invalid("Invalid canonical attachment base64");
    const mediaType = media(name, bytes),
      sha256 = createHash("sha256").update(bytes).digest("hex"),
      input = JSON.stringify({
        scope,
        name,
        sha256,
        ...(external ? { external } : {}),
      });
    const prior = this.db
      .prepare(
        "SELECT input,metadata,bytes FROM attachments WHERE request_key=?",
      )
      .get(key) as
      { input: string; metadata: string; bytes: Uint8Array } | undefined;
    if (prior) {
      if (prior.input !== input || !bytes.equals(Buffer.from(prior.bytes)))
        throw new RuntimeError(
          "conflict",
          "Attachment staging identity conflict",
        );
      return JSON.parse(prior.metadata);
    }
    const metadata: AttachmentMetadata & { external?: ExternalProvenance } = {
      ...(external ? { external } : {}),
      id: randomUUID(),
      scope,
      name,
      mediaType,
      size: bytes.length,
      sha256,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO attachments(id,request_key,input,metadata,bytes) VALUES(?,?,?,?,?)",
      )
      .run(metadata.id, key, input, JSON.stringify(metadata), bytes);
    return metadata;
  }
  private record(id: string) {
    identity(id, "attachment");
    const row = this.db
      .prepare("SELECT metadata,bytes FROM attachments WHERE id=?")
      .get(id) as { metadata: string; bytes: Uint8Array } | undefined;
    if (!row) throw new RuntimeError("not_found", "Attachment not found");
    const metadata = JSON.parse(row.metadata) as AttachmentMetadata,
      bytes = Buffer.from(row.bytes);
    if (
      metadata.id !== id ||
      bytes.length !== metadata.size ||
      createHash("sha256").update(bytes).digest("hex") !== metadata.sha256
    )
      throw new RuntimeError("conflict", "Attachment integrity mismatch");
    return { metadata, data: bytes.toString("base64") };
  }
  get(id: string): AttachmentMetadata {
    return this.record(id).metadata;
  }
  content(id: string) {
    return this.record(id);
  }
  resolve(thread: Thread, ids: string[]): ResolvedAttachment[] {
    if (
      !Array.isArray(ids) ||
      ids.length > 64 ||
      new Set(ids).size !== ids.length
    )
      invalid("Invalid attachment IDs");
    return ids.map((id) => {
      const { metadata, data } = this.record(id),
        scope = this.scope(metadata.scope);
      if (scope.profileId !== thread.profileId)
        throw new RuntimeError("conflict", "Attachment profile scope mismatch");
      if (scope.kind === "thread") {
        if (scope.threadId !== thread.id || thread.owner?.kind !== "operator")
          throw new RuntimeError(
            "conflict",
            "Attachment thread scope mismatch",
          );
      } else {
        const store = this.options.messaging()!;
        if (
          thread.owner?.kind !== "channel" ||
          thread.owner.id !== scope.channelId ||
          store.getConversation(
            scope.channelId,
            scope.profileId,
            scope.branchId,
          )?.threadId !== thread.id
        )
          throw new RuntimeError(
            "conflict",
            "Attachment channel scope mismatch",
          );
      }
      return { ...metadata, data };
    });
  }
  close() {
    this.db.close();
  }
}
