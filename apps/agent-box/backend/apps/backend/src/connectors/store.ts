import {
  reply as validateReply,
  operation as validateOperation,
  receipt as validateReceipt,
} from "./reply-validation.js";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  ConnectorError,
  type ConnectorBinding,
  type ConnectorReplyInput,
  type ConnectorReplyRecord,
  type ConnectorReplyOperationSpec,
  type ConnectorReplyOperation,
  type ConnectorReplyReceipt,
  type ConnectorEvent,
  type ConnectorAccountIdentity,
  type ConnectorAccountRecord,
  type ConnectorDispositionBatch,
  type ConnectorDispositionRecord,
  type ConnectorProvider,
  type ConnectorInboxRecord,
  type ConnectorNativeFailure,
} from "./types.js";
import {
  binding as validateBinding,
  event as validateEvent,
  object,
  id,
} from "./validation.js";
import {
  accountIdentity,
  cursor as validateCursor,
  disposition as validateDisposition,
  initialCursor,
} from "./cursor-validation.js";
import { invalid } from "./validation.js";
export * from "./types.js";
function conflict(message: string): never {
  throw new ConnectorError("conflict", message);
}
function identity(binding: ConnectorBinding): string {
  return JSON.stringify([
    binding.provider,
    binding.accountId,
    binding.chatId,
    binding.conversationId,
    binding.channelId,
    binding.profileId,
  ]);
}
/** Owns ingress durability only. It neither starts models nor sends provider messages. */
export class ConnectorStore {
  private readonly db: DatabaseSync;
  private closed = false;
  constructor({ databasePath }: { databasePath: string }) {
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;",
      );
      this.atomic(() => {
        const version = this.db.prepare("PRAGMA user_version").get()!
          .user_version;
        if (version !== 0 && version !== 1 && version !== 2 && version !== 3)
          throw new ConnectorError(
            "unavailable",
            "Unsupported connector schema version",
          );
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS bindings(id TEXT PRIMARY KEY, destination TEXT NOT NULL UNIQUE, channel_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
          CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,message_key TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,account_key TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
          CREATE TABLE IF NOT EXISTS events(event_key TEXT PRIMARY KEY,inbox_id TEXT NOT NULL REFERENCES inbox(id),fingerprint TEXT NOT NULL) STRICT;
          CREATE INDEX IF NOT EXISTS inbox_account ON inbox(account_key);
          CREATE INDEX IF NOT EXISTS event_inbox ON events(inbox_id);
          CREATE TABLE IF NOT EXISTS connector_accounts(account_key TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
          CREATE TABLE IF NOT EXISTS dispositions(seq INTEGER PRIMARY KEY AUTOINCREMENT,account_key TEXT NOT NULL,event_id TEXT NOT NULL,fingerprint TEXT NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),UNIQUE(account_key,event_id)) STRICT;
          CREATE TABLE IF NOT EXISTS connector_replies(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,inbox_id TEXT NOT NULL UNIQUE REFERENCES inbox(id),delivery_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
          PRAGMA user_version=3;
        `);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  private check(): void {
    if (this.closed)
      throw new ConnectorError("unavailable", "Connector store is closed");
  }
  private atomic<T>(run: () => T): T {
    this.check();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Freeze the exact native completion and destination before any provider effects. */
  enqueueReply(
    inboxId: string,
    input: ConnectorReplyInput,
  ): ConnectorReplyRecord {
    const frozen = validateReply(input);
    return this.atomic(() => {
      const inbox = this.get(inboxId);
      if (inbox.nativeMessageId !== frozen.nativeMessageId)
        conflict("Native reply message linkage conflict");
      if (inbox.replyId) {
        const prior = this.getReply(inbox.replyId);
        const priorInput = validateReply({
          nativeMessageId: prior.nativeMessageId,
          nativeDeliveryId: prior.nativeDeliveryId,
          runId: prior.runId,
          ...(prior.replyMessageId
            ? { replyMessageId: prior.replyMessageId }
            : {}),
          text: prior.text,
          files: prior.files,
        });
        if (JSON.stringify(priorInput) !== JSON.stringify(frozen))
          conflict("Native reply completion replay conflict");
        return prior;
      }
      if (inbox.state !== "admitted" || inbox.outcome)
        conflict("Inbox is not awaiting a native reply");
      if (
        this.db
          .prepare("SELECT id FROM connector_replies WHERE delivery_id=?")
          .get(frozen.nativeDeliveryId)
      )
        conflict("Native delivery is already linked to another reply");
      const reply: ConnectorReplyRecord = {
        ...frozen,
        id: createHash("sha256")
          .update(JSON.stringify([inboxId, frozen.nativeDeliveryId]))
          .digest("hex"),
        inboxId,
        binding: inbox.binding,
        event: inbox.event,
        state: "planned",
        operations: [],
        planned: false,
        createdAt: Date.now(),
      };
      this.db
        .prepare(
          "INSERT INTO connector_replies(id,inbox_id,delivery_id,data) VALUES(?,?,?,?)",
        )
        .run(reply.id, inboxId, frozen.nativeDeliveryId, JSON.stringify(reply));
      this.db
        .prepare("UPDATE inbox SET data=? WHERE id=?")
        .run(JSON.stringify({ ...inbox, replyId: reply.id }), inboxId);
      return reply;
    });
  }
  getReply(replyId: string): ConnectorReplyRecord {
    this.check();
    const row = this.db
      .prepare("SELECT data FROM connector_replies WHERE id=?")
      .get(id(replyId));
    if (!row)
      throw new ConnectorError("not_found", "Connector reply not found");
    return JSON.parse(row.data as string) as ConnectorReplyRecord;
  }
  listReplies(
    options: { after?: string; limit?: number } = {},
  ): ConnectorReplyRecord[] {
    this.check();
    object(options, ["after", "limit"]);
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      invalid("Invalid reply page");
    let after = 0;
    if (options.after !== undefined) {
      const row = this.db
        .prepare("SELECT seq FROM connector_replies WHERE id=?")
        .get(id(options.after));
      if (!row) throw new ConnectorError("not_found", "Reply cursor not found");
      after = row.seq as number;
    }
    return this.db
      .prepare(
        "SELECT data FROM connector_replies WHERE seq>? AND json_extract(data,'$.state')!='completed' ORDER BY seq LIMIT ?",
      )
      .all(after, limit)
      .map((row) => JSON.parse(row.data as string) as ConnectorReplyRecord);
  }
  private saveReply(reply: ConnectorReplyRecord): ConnectorReplyRecord {
    this.db
      .prepare("UPDATE connector_replies SET data=? WHERE id=?")
      .run(JSON.stringify(reply), reply.id);
    return reply;
  }
  planReply(
    replyId: string,
    input: ConnectorReplyOperationSpec[],
  ): ConnectorReplyRecord {
    if (!Array.isArray(input) || input.length > 100)
      invalid("Invalid reply plan");
    const specs = Array.from(input, validateOperation);
    if (new Set(specs.map((spec) => spec.id)).size !== specs.length)
      invalid("Duplicate reply operation");
    return this.atomic(() => {
      const reply = this.getReply(replyId);
      if (reply.planned) {
        const previous = reply.operations.map((op) =>
          validateOperation(
            op.kind === "text"
              ? { id: op.id, kind: op.kind, text: op.text }
              : { id: op.id, kind: op.kind, fileId: op.fileId },
          ),
        );
        if (JSON.stringify(previous) !== JSON.stringify(specs))
          conflict("Reply plan replay conflict");
        return reply;
      }
      if (
        specs
          .filter((op) => op.kind === "text")
          .map((op) => op.text)
          .join("") !== reply.text ||
        JSON.stringify(
          specs.filter((op) => op.kind === "file").map((op) => op.fileId),
        ) !== JSON.stringify(reply.files.map((file) => file.id))
      )
        conflict("Reply plan content conflict");
      return this.saveReply({
        ...reply,
        planned: true,
        operations: specs.map((spec) => ({ ...spec, state: "planned" })),
      });
    });
  }
  replyAuthorized(replyId: string, input: ConnectorAccountIdentity): boolean {
    const identity = accountIdentity(input),
      reply = this.getReply(replyId),
      binding = this.getBinding(reply.binding.id);
    if (
      reply.state === "completed" ||
      !binding.enabled ||
      JSON.stringify(binding) !== JSON.stringify(reply.binding) ||
      identity.provider !== binding.provider ||
      identity.accountId !== binding.accountId ||
      identity.credentialGeneration !== binding.credentialGeneration
    )
      return false;
    try {
      return (
        this.getAccount(identity.provider, identity.accountId)
          .credentialGeneration === identity.credentialGeneration
      );
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "not_found")
        return false;
      throw error;
    }
  }
  private changeReplyOperation(
    replyId: string,
    operationId: string,
    change: (
      op: ConnectorReplyOperation,
      reply: ConnectorReplyRecord,
    ) => ConnectorReplyOperation,
  ): ConnectorReplyRecord {
    return this.atomic(() => {
      const reply = this.getReply(replyId);
      if (reply.state === "completed") conflict("Reply is already completed");
      const index = reply.operations.findIndex(
        (op) => op.id === id(operationId),
      );
      if (index < 0)
        throw new ConnectorError("not_found", "Reply operation not found");
      const operations = [...reply.operations];
      operations[index] = change(operations[index]!, reply);
      const state = operations.some((op) => op.state === "uncertain")
        ? "uncertain"
        : operations.some((op) => op.state === "in_flight")
          ? "sending"
          : "planned";
      return this.saveReply({ ...reply, operations, state });
    });
  }
  beginReplyOperation(
    replyId: string,
    operationId: string,
    identity: ConnectorAccountIdentity,
  ): ConnectorReplyRecord {
    return this.changeReplyOperation(replyId, operationId, (op, reply) => {
      if (
        Math.max(
          reply.retryNotBefore ?? 0,
          this.getAccount(reply.binding.provider, reply.binding.accountId)
            .replyRetryNotBefore ?? 0,
        ) > Date.now()
      )
        throw new ConnectorError(
          "unavailable",
          "Provider retry window has not elapsed",
        );
      if (
        this.getAccount(reply.binding.provider, reply.binding.accountId)
          .replyRetryBlocked
      )
        throw new ConnectorError(
          "unavailable",
          "Provider rate limit requires review",
        );
      if (!this.replyAuthorized(replyId, identity))
        throw new ConnectorError(
          "unauthorized",
          "Reply binding or account authority changed",
        );
      if (
        op.state !== "planned" ||
        reply.operations.some(
          (other) => other.state === "in_flight" || other.state === "uncertain",
        )
      )
        conflict("Reply operation is not safe to send");
      return { ...op, state: "in_flight" };
    });
  }
  confirmReplyOperation(
    replyId: string,
    operationId: string,
    input: ConnectorReplyReceipt,
  ): ConnectorReplyRecord {
    const receipt = validateReceipt(input);
    return this.changeReplyOperation(replyId, operationId, (op, reply) => {
      if (
        receipt.provider !== reply.binding.provider ||
        receipt.accountId !== reply.binding.accountId ||
        receipt.chatId !== reply.binding.chatId ||
        receipt.conversationId !== reply.binding.conversationId
      )
        conflict("Reply receipt destination conflict");
      if (op.state === "confirmed") {
        if (JSON.stringify(op.receipt) !== JSON.stringify(receipt))
          conflict("Reply receipt replay conflict");
        return op;
      }
      if (op.state !== "in_flight" && op.state !== "uncertain")
        conflict("Reply operation has not been sent");
      if (
        reply.operations.some(
          (other) =>
            other.id !== op.id &&
            other.receipt?.messageId === receipt.messageId,
        )
      )
        conflict("Provider receipt already confirms another operation");
      return { ...op, state: "confirmed", receipt };
    });
  }
  markReplyUncertain(
    replyId: string,
    operationId: string,
  ): ConnectorReplyRecord {
    return this.changeReplyOperation(replyId, operationId, (op) => {
      if (op.state !== "in_flight" && op.state !== "uncertain")
        conflict("Reply operation is not in flight");
      return { ...op, state: "uncertain" };
    });
  }
  pauseReplyAccount(replyId: string): void {
    this.atomic(() => {
      const reply = this.getReply(replyId),
        account = this.getAccount(
          reply.binding.provider,
          reply.binding.accountId,
        );
      account.replyRetryBlocked = true;
      this.db
        .prepare("UPDATE connector_accounts SET data=? WHERE account_key=?")
        .run(
          JSON.stringify(account),
          JSON.stringify([account.provider, account.accountId]),
        );
    });
  }
  private deferAccount(
    reply: ConnectorReplyRecord,
    retryAfterMs: number,
  ): void {
    const account = this.getAccount(
      reply.binding.provider,
      reply.binding.accountId,
    );
    account.replyRetryNotBefore = Math.max(
      account.replyRetryNotBefore ?? 0,
      Date.now() + retryAfterMs,
    );
    this.db
      .prepare("UPDATE connector_accounts SET data=? WHERE account_key=?")
      .run(
        JSON.stringify(account),
        JSON.stringify([account.provider, account.accountId]),
      );
  }
  deferReply(replyId: string, retryAfterMs: number): ConnectorReplyRecord {
    if (
      !Number.isSafeInteger(retryAfterMs) ||
      retryAfterMs < 0 ||
      retryAfterMs > 86400000
    )
      invalid("Invalid provider retry delay");
    return this.atomic(() => {
      const reply = this.getReply(replyId);
      if (reply.state === "completed") return reply;
      this.deferAccount(reply, retryAfterMs);
      return this.saveReply({
        ...reply,
        retryNotBefore: Math.max(
          reply.retryNotBefore ?? 0,
          Date.now() + retryAfterMs,
        ),
      });
    });
  }
  /** Only a definitive provider rejection permits retry; uncertainty is never cleared here. */
  rejectReplyOperation(
    replyId: string,
    operationId: string,
    retryAfterMs = 0,
  ): ConnectorReplyRecord {
    if (
      !Number.isSafeInteger(retryAfterMs) ||
      retryAfterMs < 0 ||
      retryAfterMs > 86400000
    )
      invalid("Invalid provider retry delay");
    return this.changeReplyOperation(replyId, operationId, (op, reply) => {
      this.deferAccount(reply, retryAfterMs);
      reply.retryNotBefore = Math.max(
        reply.retryNotBefore ?? 0,
        Date.now() + retryAfterMs,
      );
      if (op.state !== "in_flight")
        conflict("Reply operation is not in flight");
      return { ...op, state: "planned" };
    });
  }
  /** Invoke only after acquiring exclusive send ownership, before starting sends. */
  recoverReplies(input: ConnectorAccountIdentity): void {
    const identity = accountIdentity(input);
    this.atomic(() => {
      const rows = this.db
        .prepare(
          "SELECT data FROM connector_replies WHERE json_extract(data,'$.state')!='completed' AND json_extract(data,'$.binding.provider')=? AND json_extract(data,'$.binding.accountId')=?",
        )
        .all(identity.provider, identity.accountId);
      for (const row of rows) {
        const reply = JSON.parse(row.data as string) as ConnectorReplyRecord;
        if (reply.operations.some((op) => op.state === "in_flight"))
          this.saveReply({
            ...reply,
            state: "uncertain",
            operations: reply.operations.map((op) =>
              op.state === "in_flight" ? { ...op, state: "uncertain" } : op,
            ),
          });
      }
    });
  }
  completeReply(replyId: string): ConnectorReplyRecord {
    return this.atomic(() => {
      const reply = this.getReply(replyId);
      if (reply.state === "completed") return reply;
      if (
        !reply.planned ||
        reply.operations.some((op) => op.state !== "confirmed")
      )
        conflict("Reply still has unconfirmed operations");
      const inbox = this.get(reply.inboxId);
      if (inbox.replyId !== reply.id) conflict("Reply inbox linkage conflict");
      this.db
        .prepare("UPDATE inbox SET data=? WHERE id=?")
        .run(JSON.stringify({ ...inbox, state: "closed" }), inbox.id);
      return this.saveReply({ ...reply, state: "completed" });
    });
  }
  /** Only a receiver that verified the bot identity may configure this account. */
  configureAccount(
    input: ConnectorAccountIdentity & { expectedRevision?: number },
  ): ConnectorAccountRecord {
    object(input, [
      "provider",
      "accountId",
      "credentialGeneration",
      "expectedRevision",
    ]);
    const identity = accountIdentity({
        provider: input.provider,
        accountId: input.accountId,
        credentialGeneration: input.credentialGeneration,
      }),
      key = JSON.stringify([identity.provider, identity.accountId]);
    return this.atomic(() => {
      const row = this.db
        .prepare("SELECT data FROM connector_accounts WHERE account_key=?")
        .get(key);
      const prior = row
        ? (JSON.parse(row.data as string) as ConnectorAccountRecord)
        : undefined;
      if (prior?.credentialGeneration === identity.credentialGeneration)
        return prior;
      if (prior && input.expectedRevision !== prior.revision)
        conflict("Account rotation revision conflict");
      if (!prior && input.expectedRevision !== undefined)
        conflict("Account does not yet have a revision");
      const next: ConnectorAccountRecord = {
        ...identity,
        revision: (prior?.revision ?? 0) + 1,
        cursor: initialCursor(identity.provider, !!prior),
        ...(prior?.replyRetryBlocked ? { replyRetryBlocked: true } : {}),
        ...(prior?.replyRetryNotBefore
          ? { replyRetryNotBefore: prior.replyRetryNotBefore }
          : {}),
      };
      this.db
        .prepare(
          "INSERT INTO connector_accounts VALUES(?,?) ON CONFLICT(account_key) DO UPDATE SET data=excluded.data",
        )
        .run(key, JSON.stringify(next));
      return next;
    });
  }
  getAccount(
    provider: ConnectorProvider,
    accountId: string,
  ): ConnectorAccountRecord {
    this.check();
    accountIdentity({
      provider,
      accountId,
      credentialGeneration: "validation",
    });
    const row = this.db
      .prepare("SELECT data FROM connector_accounts WHERE account_key=?")
      .get(JSON.stringify([provider, accountId]));
    if (!row)
      throw new ConnectorError("not_found", "Connector account not found");
    return JSON.parse(row.data as string) as ConnectorAccountRecord;
  }
  commitDispositionBatch(
    input: ConnectorDispositionBatch,
  ): ConnectorAccountRecord {
    object(input, [
      "provider",
      "accountId",
      "credentialGeneration",
      "expectedRevision",
      "dispositions",
      "nextCursor",
    ]);
    const identity = accountIdentity({
      provider: input.provider,
      accountId: input.accountId,
      credentialGeneration: input.credentialGeneration,
    });
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      !Array.isArray(input.dispositions) ||
      input.dispositions.length > 100
    )
      invalid("Invalid disposition batch");
    const nextCursor = validateCursor(input.nextCursor, identity.provider),
      dispositions = Array.from(input.dispositions, validateDisposition),
      key = JSON.stringify([identity.provider, identity.accountId]);
    return this.atomic(() => {
      const prior = this.getAccount(identity.provider, identity.accountId);
      if (prior.credentialGeneration !== identity.credentialGeneration)
        conflict("Account credential generation conflict");
      if (prior.revision !== input.expectedRevision)
        conflict("Account cursor revision conflict");
      for (const item of dispositions) {
        const old = this.db
          .prepare(
            "SELECT fingerprint FROM dispositions WHERE account_key=? AND event_id=?",
          )
          .get(key, item.eventId);
        if (old) {
          if (old.fingerprint !== item.fingerprint)
            conflict("Provider payload replay conflict");
          continue;
        }
        let inboxId: string | undefined;
        if (item.status === "accepted") {
          const event = item.event;
          if (
            event.provider !== identity.provider ||
            event.accountId !== identity.accountId ||
            event.credentialGeneration !== identity.credentialGeneration ||
            event.eventId !== item.eventId
          )
            invalid("Disposition event identity mismatch");
          inboxId = this.acceptInTransaction(
            item.bindingId,
            item.bindingRevision,
            event,
          ).id;
        }
        const record = {
          ...identity,
          eventId: item.eventId,
          fingerprint: item.fingerprint,
          status: item.status,
          ...(inboxId ? { inboxId } : {}),
          createdAt: Date.now(),
        };
        this.db
          .prepare(
            "INSERT INTO dispositions(account_key,event_id,fingerprint,data) VALUES(?,?,?,?)",
          )
          .run(key, item.eventId, item.fingerprint, JSON.stringify(record));
      }
      const next = {
        ...prior,
        revision: prior.revision + 1,
        cursor: nextCursor,
      };
      this.db
        .prepare("UPDATE connector_accounts SET data=? WHERE account_key=?")
        .run(JSON.stringify(next), key);
      return next;
    });
  }
  /** Bounded metadata pages retain durable replay tombstones without raw provider payloads. */
  listDispositions(
    provider: ConnectorProvider,
    accountId: string,
    options: { after?: number; limit?: number } = {},
  ): ConnectorDispositionRecord[] {
    this.check();
    this.getAccount(provider, accountId);
    object(options, ["after", "limit"]);
    const after = options.after ?? 0,
      limit = options.limit ?? 100;
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      invalid("Invalid disposition page");
    return this.db
      .prepare(
        "SELECT seq,data FROM dispositions WHERE account_key=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(JSON.stringify([provider, accountId]), after, limit)
      .map(
        (row) =>
          ({
            ...JSON.parse(row.data as string),
            seq: row.seq as number,
          }) as ConnectorDispositionRecord,
      );
  }
  dispositionCounts(
    provider: ConnectorProvider,
    accountId: string,
  ): Partial<Record<ConnectorDispositionRecord["status"], number>> {
    this.check();
    accountIdentity({
      provider,
      accountId,
      credentialGeneration: "validation",
    });
    const rows = this.db
      .prepare(
        "SELECT json_extract(data,'$.status') AS status,count(*) AS count FROM dispositions WHERE account_key=? GROUP BY status",
      )
      .all(JSON.stringify([provider, accountId]));
    return Object.fromEntries(rows.map((row) => [row.status, row.count]));
  }
  getBinding(bindingId: string): ConnectorBinding {
    this.check();
    const row = this.db
      .prepare("SELECT data FROM bindings WHERE id=?")
      .get(id(bindingId));
    if (!row)
      throw new ConnectorError("not_found", "Connector binding not found");
    return JSON.parse(row.data as string) as ConnectorBinding;
  }
  configure(input: ConnectorBinding): ConnectorBinding {
    const next = validateBinding(input);
    return this.atomic(() => {
      const prior = this.db
        .prepare("SELECT data FROM bindings WHERE id=?")
        .get(next.id);
      if (prior) {
        const old = JSON.parse(prior.data as string) as ConnectorBinding;
        if (JSON.stringify(old) === JSON.stringify(next)) return old;
        if (next.revision !== old.revision + 1)
          conflict("Binding revision conflict");
        if (identity(old) !== identity(next))
          conflict(
            "Binding identity is immutable; provision a separate binding and conversation",
          );
        this.db
          .prepare("UPDATE bindings SET data=? WHERE id=?")
          .run(JSON.stringify(next), next.id);
      } else {
        if (next.revision !== 1)
          conflict("Initial binding revision must be one");
        const destination = JSON.stringify([
          next.provider,
          next.accountId,
          next.chatId,
          next.conversationId,
        ]);
        if (
          this.db
            .prepare(
              "SELECT id FROM bindings WHERE destination=? OR channel_id=?",
            )
            .get(destination, next.channelId)
        )
          conflict("Conversation already assigned to a binding");
        this.db
          .prepare("INSERT INTO bindings VALUES(?,?,?,?)")
          .run(next.id, destination, next.channelId, JSON.stringify(next));
      }
      return next;
    });
  }
  get(inboxId: string): ConnectorInboxRecord {
    this.check();
    const row = this.db
      .prepare("SELECT data FROM inbox WHERE id=?")
      .get(id(inboxId));
    if (!row)
      throw new ConnectorError("not_found", "Connector inbox record not found");
    return JSON.parse(row.data as string) as ConnectorInboxRecord;
  }
  resolveReplyReference(input: {
    provider: ConnectorProvider;
    accountId: string;
    chatId: string;
    conversationId: string;
    messageId: string;
  }): { nativeMessageId: string } | undefined {
    this.check();
    const row = object(input, [
      "provider",
      "accountId",
      "chatId",
      "conversationId",
      "messageId",
    ]);
    if (row.provider !== "telegram" && row.provider !== "discord")
      invalid("Invalid provider reply reference");
    for (const key of ["accountId", "chatId", "conversationId", "messageId"])
      id(row[key]);
    const messageKey = JSON.stringify([
      input.provider,
      input.accountId,
      ...(input.provider === "telegram" ? [input.chatId] : []),
      input.messageId,
    ]);
    const original = this.db
      .prepare("SELECT data FROM inbox WHERE message_key=?")
      .get(messageKey);
    const matches = new Set<string>();
    if (original) {
      const record = JSON.parse(
        original.data as string,
      ) as ConnectorInboxRecord;
      if (
        record.event.chatId === input.chatId &&
        record.event.conversationId === input.conversationId &&
        record.nativeMessageId
      )
        matches.add(record.nativeMessageId);
    }
    const replies = this.db
      .prepare(
        `SELECT r.data FROM connector_replies r, json_each(r.data,'$.operations') operation
      WHERE json_extract(operation.value,'$.state')='confirmed'
      AND json_extract(operation.value,'$.receipt.provider')=?
      AND json_extract(operation.value,'$.receipt.accountId')=?
      AND json_extract(operation.value,'$.receipt.chatId')=?
      AND json_extract(operation.value,'$.receipt.conversationId')=?
      AND json_extract(operation.value,'$.receipt.messageId')=? LIMIT 2`,
      )
      .all(
        input.provider,
        input.accountId,
        input.chatId,
        input.conversationId,
        input.messageId,
      );
    for (const reply of replies) {
      const record = JSON.parse(reply.data as string) as ConnectorReplyRecord;
      if (record.replyMessageId) matches.add(record.replyMessageId);
    }
    if (matches.size > 1) conflict("Ambiguous provider reply mapping");
    const nativeMessageId = [...matches][0];
    return nativeMessageId ? { nativeMessageId } : undefined;
  }
  accept(
    bindingId: string,
    expectedRevision: number,
    input: unknown,
  ): ConnectorInboxRecord {
    const incoming = validateEvent(input);
    return this.atomic(() =>
      this.acceptInTransaction(bindingId, expectedRevision, incoming),
    );
  }
  private acceptInTransaction(
    bindingId: string,
    expectedRevision: number,
    incoming: ConnectorEvent,
  ): ConnectorInboxRecord {
    const binding = this.getBinding(bindingId);
    if (
      !binding.enabled ||
      binding.revision !== expectedRevision ||
      binding.provider !== incoming.provider ||
      binding.accountId !== incoming.accountId ||
      binding.credentialGeneration !== incoming.credentialGeneration ||
      binding.chatId !== incoming.chatId ||
      binding.conversationId !== incoming.conversationId ||
      !binding.allowedUserIds.includes(incoming.userId)
    ) {
      throw new ConnectorError(
        "unauthorized",
        "Input does not match enabled binding authority",
      );
    }
    const accountKey = JSON.stringify([incoming.provider, incoming.accountId]);
    const eventKey = JSON.stringify([
      incoming.provider,
      incoming.accountId,
      incoming.eventId,
    ]);
    const messageKey = JSON.stringify([
      incoming.provider,
      incoming.accountId,
      ...(incoming.provider === "telegram" ? [incoming.chatId] : []),
      incoming.messageId,
    ]);
    // A provider redelivery under a refreshed credential generation is still the same message.
    // Its original binding snapshot remains authoritative for all subsequent work.
    const fingerprint = JSON.stringify([
      binding.id,
      incoming.provider,
      incoming.accountId,
      incoming.chatId,
      incoming.conversationId,
      incoming.messageId,
      incoming.userId,
      incoming.text,
      ...(incoming.attachmentIds?.length || incoming.replyToNativeMessageId
        ? [
            {
              attachmentIds: incoming.attachmentIds ?? [],
              replyToNativeMessageId: incoming.replyToNativeMessageId ?? null,
            },
          ]
        : []),
    ]);
    const previousEvent = this.db
      .prepare("SELECT inbox_id,fingerprint FROM events WHERE event_key=?")
      .get(eventKey);
    if (previousEvent) {
      if (previousEvent.fingerprint !== fingerprint)
        conflict("Provider event replay conflict");
      return this.get(previousEvent.inbox_id as string);
    }
    const previous = this.db
      .prepare("SELECT id,fingerprint FROM inbox WHERE message_key=?")
      .get(messageKey);
    if (previous && previous.fingerprint !== fingerprint)
      conflict("Provider message replay conflict");
    let record: ConnectorInboxRecord;
    if (previous) {
      record = this.get(previous.id as string);
      const aliases = this.db
        .prepare("SELECT count(*) AS count FROM events WHERE inbox_id=?")
        .get(record.id)!.count as number;
      if (aliases >= 128)
        throw new ConnectorError(
          "unavailable",
          "Provider event alias limit reached",
        );
    } else {
      const count = this.db
        .prepare(
          "SELECT count(*) AS count FROM inbox WHERE account_key=? AND json_extract(data,'$.state') IN ('accepted','admitted')",
        )
        .get(accountKey)!.count as number;
      if (count >= 1000)
        throw new ConnectorError(
          "unavailable",
          "Connector account backlog limit reached",
        );
      record = {
        id: createHash("sha256").update(messageKey).digest("hex"),
        binding,
        event: incoming,
        state: "accepted",
        createdAt: Date.now(),
      };
      this.db
        .prepare(
          "INSERT INTO inbox(id,message_key,fingerprint,account_key,data) VALUES(?,?,?,?,?)",
        )
        .run(
          record.id,
          messageKey,
          fingerprint,
          accountKey,
          JSON.stringify(record),
        );
    }
    this.db
      .prepare("INSERT INTO events VALUES(?,?,?)")
      .run(eventKey, record.id, fingerprint);
    return record;
  }
  /** Compare current authority with the immutable admission snapshot before new effects. */
  authorized(inboxId: string): boolean {
    const record = this.get(inboxId),
      current = this.getBinding(record.binding.id);
    return (
      ["accepted", "admitted"].includes(record.state) &&
      current.enabled &&
      JSON.stringify(current) === JSON.stringify(record.binding)
    );
  }
  /** Linkage reconciles an existing native receipt and remains possible after revocation. */
  linkNative(inboxId: string, messageId: string): ConnectorInboxRecord {
    const nativeMessageId = id(messageId);
    return this.atomic(() => {
      const record = this.get(inboxId);
      if (record.nativeMessageId && record.nativeMessageId !== nativeMessageId)
        conflict("Native message linkage conflict");
      if (record.nativeMessageId) return record;
      const next: ConnectorInboxRecord = {
        ...record,
        nativeMessageId,
        state: "admitted",
      };
      this.db
        .prepare("UPDATE inbox SET data=? WHERE id=?")
        .run(JSON.stringify(next), record.id);
      return next;
    });
  }
  /** Caller first reconciles any native receipt; revocation never fabricates one. */
  revokeUnadmitted(inboxId: string): ConnectorInboxRecord {
    return this.atomic(() => {
      const record = this.get(inboxId);
      if (record.nativeMessageId)
        conflict("Native receipt requires native outcome reconciliation");
      if (record.state === "revoked") return record;
      if (this.authorized(inboxId))
        conflict("Binding authority still permits admission");
      const next: ConnectorInboxRecord = {
        ...record,
        state: "revoked",
        revokedAt: Date.now(),
      };
      this.db
        .prepare("UPDATE inbox SET data=? WHERE id=?")
        .run(JSON.stringify(next), inboxId);
      return next;
    });
  }
  /** Trusted native terminal receipt: failed input has no provider reply to send. */
  finishWithoutReply(
    inboxId: string,
    input: ConnectorNativeFailure,
  ): ConnectorInboxRecord {
    object(input, ["nativeMessageId", "state", "reason"]);
    const outcome: ConnectorNativeFailure = {
      nativeMessageId: id(input.nativeMessageId),
      state: input.state,
      reason: input.reason,
    };
    if (
      !["failed", "cancelled", "blocked"].includes(outcome.state) ||
      typeof outcome.reason !== "string" ||
      outcome.reason.length > 32000 ||
      outcome.reason.includes("\0")
    )
      throw new ConnectorError("invalid", "Invalid native terminal outcome");
    return this.atomic(() => {
      const record = this.get(inboxId);
      if (record.nativeMessageId !== outcome.nativeMessageId)
        conflict("Native terminal receipt mismatch");
      if (record.outcome) {
        if (JSON.stringify(record.outcome) !== JSON.stringify(outcome))
          conflict("Native terminal outcome conflict");
        return record;
      }
      const next: ConnectorInboxRecord = {
        ...record,
        state: "closed",
        outcome,
      };
      this.db
        .prepare("UPDATE inbox SET data=? WHERE id=?")
        .run(JSON.stringify(next), record.id);
      return next;
    });
  }
  pending(after?: string): ConnectorInboxRecord[] {
    this.check();
    let seq = 0;
    if (after !== undefined) {
      const prior = this.db
        .prepare("SELECT seq FROM inbox WHERE id=?")
        .get(id(after));
      if (!prior)
        throw new ConnectorError("not_found", "Inbox cursor not found");
      seq = prior.seq as number;
    }
    return this.db
      .prepare(
        "SELECT data FROM inbox WHERE seq>? AND json_extract(data,'$.state') IN ('accepted','admitted') ORDER BY seq LIMIT 100",
      )
      .all(seq)
      .map((row) => JSON.parse(row.data as string) as ConnectorInboxRecord);
  }
}
