import { conversationOutputManifest } from "@mindi/agent-runtime";
import {
  taskOutputManifest,
  type TaskOutputMetadata,
} from "@mindi/agent-runtime/task-outputs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  MessagingError,
  type ChannelAttachmentResolver,
  type AgentAttachmentForwarder,
  type ExternalAttachmentResolver,
  type ChannelAttachmentScope,
  type ChannelAttachmentMetadata,
  type Channel,
  type PublishRoutineOutput,
  type PublishTaskDiscussionAnchor,
  type PublishDeploymentNotification,
  type ChannelBranch,
  type CreateBranch,
  type BranchFork,
  type BeginBranchFork,
  type Delivery,
  type Conversation,
  type FinishDelivery,
  type Message,
  type CreateChannel,
  type UpdateChannel,
  type PostMessage,
  type PostAgentMessage,
  type PageInput,
  type Page,
} from "./types.js";
export * from "./types.js";
export { externalMemberId } from "./external.js";
import {
  externalBinding,
  externalProvenance,
  externalMemberId,
  externalConversationKey,
  externalMessageKey,
  externalAttachments,
  externalAttachmentIds,
} from "./external.js";
import type {
  ExternalProvenance,
  ExternalConversationBinding,
  AdmitExternalMessage,
} from "./types.js";
function invalid(message: string): never {
  throw new MessagingError("invalid", message);
}
function conflict(message: string): never {
  throw new MessagingError("conflict", message);
}
function str(value: unknown, field: string, max = 200): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    invalid(`Invalid ${field}`);
  return value;
}
function plain(value: unknown, fields: string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid("Invalid input object");
  if (
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        !fields.includes(key) ||
        !("value" in Object.getOwnPropertyDescriptor(value, key)!),
    )
  )
    invalid("Invalid input fields");
}
function member(value: unknown): string {
  const id = str(value, "member");
  if (id !== "operator" && !/^agent:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))
    invalid("Invalid member identity");
  return id;
}
function members(value: unknown, retained: string[] = []): string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 100 ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) ||
        !("value" in Object.getOwnPropertyDescriptor(value, key)!),
    )
  )
    invalid("Invalid members");
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    result.push(
      typeof item === "string" &&
        /^external:[a-f0-9]{64}$/.test(item) &&
        retained.includes(item)
        ? item
        : member(item),
    );
  }
  if (new Set(result).size !== result.length) invalid("Duplicate members");
  return result.sort();
}
export class MessagingStore {
  private db: DatabaseSync;
  private closed = false;
  private forwardAgentAttachments?: AgentAttachmentForwarder;
  private resolveAttachments?: ChannelAttachmentResolver;
  private resolveExternalAttachments?: ExternalAttachmentResolver;
  private profileAvailable?: (profileId: string) => boolean;
  constructor({
    databasePath,
    profileAvailable,
    resolveAttachments,
    resolveExternalAttachments,
    forwardAgentAttachments,
  }: {
    databasePath: string;
    resolveAttachments?: ChannelAttachmentResolver;
    resolveExternalAttachments?: ExternalAttachmentResolver;
    forwardAgentAttachments?: AgentAttachmentForwarder;
    profileAvailable?: (profileId: string) => boolean;
  }) {
    this.forwardAgentAttachments = forwardAgentAttachments;
    this.profileAvailable = profileAvailable;
    this.resolveAttachments = resolveAttachments;
    this.resolveExternalAttachments = resolveExternalAttachments;
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;",
      );
      this.atomic(() => {
        const version = this.db.prepare("PRAGMA user_version").get()!
          .user_version;
        if (
          version !== 0 &&
          version !== 1 &&
          version !== 2 &&
          version !== 3 &&
          version !== 4 &&
          version !== 5
        )
          throw new MessagingError(
            "unavailable",
            "Unsupported messaging schema version",
          );
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS channels(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,dm_key TEXT UNIQUE,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
 CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,channel_id TEXT NOT NULL REFERENCES channels(id),data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
 CREATE INDEX IF NOT EXISTS channel_messages ON messages(channel_id,seq);
 CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,key)) STRICT;
 CREATE TABLE IF NOT EXISTS deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE REFERENCES messages(id),channel_id TEXT NOT NULL REFERENCES channels(id),data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
 CREATE INDEX IF NOT EXISTS channel_deliveries ON deliveries(channel_id,seq);
 CREATE INDEX IF NOT EXISTS delivery_input_provenance ON deliveries(json_extract(data,'$.profileId'),json_extract(data,'$.messageId'));
 CREATE INDEX IF NOT EXISTS delivery_output_provenance ON deliveries(json_extract(data,'$.profileId'),json_extract(data,'$.replyMessageId'));
 CREATE TABLE IF NOT EXISTS conversations(channel_id TEXT NOT NULL REFERENCES channels(id),profile_id TEXT NOT NULL,thread_id TEXT NOT NULL,PRIMARY KEY(channel_id,profile_id)) STRICT;
 CREATE UNIQUE INDEX IF NOT EXISTS delivery_native_run ON deliveries(json_extract(data,'$.runId')) WHERE json_extract(data,'$.runId') IS NOT NULL;
 CREATE TABLE IF NOT EXISTS origin_run_roots(run_id TEXT PRIMARY KEY,profile_id TEXT NOT NULL,root_id TEXT NOT NULL REFERENCES messages(id)) STRICT;
 CREATE TABLE IF NOT EXISTS causal_budgets(root_id TEXT PRIMARY KEY,admitted INTEGER NOT NULL CHECK(admitted>=0)) STRICT;
 CREATE TABLE IF NOT EXISTS branches(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,channel_id TEXT NOT NULL REFERENCES channels(id),data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
 CREATE TABLE IF NOT EXISTS branch_forks(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,branch_id TEXT NOT NULL REFERENCES branches(id),data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
 CREATE UNIQUE INDEX IF NOT EXISTS active_branch_fork ON branch_forks(branch_id,json_extract(data,'$.profileId')) WHERE json_extract(data,'$.state') != 'cancelled';
 CREATE TABLE IF NOT EXISTS branch_conversations(branch_id TEXT NOT NULL REFERENCES branches(id),profile_id TEXT NOT NULL,thread_id TEXT NOT NULL,PRIMARY KEY(branch_id,profile_id)) STRICT;
 CREATE TABLE IF NOT EXISTS external_conversations(key TEXT PRIMARY KEY,data TEXT NOT NULL CHECK(json_valid(data))) STRICT;
 CREATE TABLE IF NOT EXISTS external_messages(key TEXT PRIMARY KEY,message_id TEXT NOT NULL UNIQUE REFERENCES messages(id)) STRICT;
 PRAGMA user_version=5;`);
        if (version === 2) {
          // Existing intent rows reserve budget even when later cancelled or blocked.
          this.db.exec(`INSERT INTO causal_budgets(root_id,admitted)
            SELECT json_extract(messages.data,'$.rootId'), count(*)
            FROM deliveries JOIN messages ON messages.id=deliveries.id
            GROUP BY json_extract(messages.data,'$.rootId');`);
        }
        if (version < 2) {
          for (const row of this.db
            .prepare("SELECT data FROM messages ORDER BY seq")
            .all())
            this.insertDelivery(JSON.parse(row.data as string) as Message);
        }
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
      throw new MessagingError("closed", "Messaging store is closed");
  }
  private atomic<T>(run: () => T): T {
    this.check();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private available(id: string): void {
    if (
      id.startsWith("agent:") &&
      this.profileAvailable &&
      !this.profileAvailable(id.slice(6))
    )
      invalid(`Unavailable profile ${id}`);
  }
  private read<T>(
    table: "channels" | "messages" | "deliveries" | "branches" | "branch_forks",
    id: string,
  ): T {
    this.check();
    str(id, "id");
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new MessagingError("not_found", `${table} not found`);
    return JSON.parse(row.data as string) as T;
  }
  private idempotent<T>(
    scope: string,
    key: string,
    input: unknown,
    run: () => T,
  ): T {
    str(key, "idempotencyKey");
    const identity = JSON.stringify(input);
    const prior = this.db
      .prepare("SELECT input,result FROM idempotency WHERE scope=? AND key=?")
      .get(scope, key);
    if (prior) {
      if (prior.input !== identity) conflict("Idempotency payload conflict");
      return JSON.parse(prior.result as string) as T;
    }
    const result = run();
    this.db
      .prepare("INSERT INTO idempotency VALUES(?,?,?,?)")
      .run(scope, key, identity, JSON.stringify(result));
    return result;
  }
  private insertChannel(
    name: string,
    assigned: string[],
    coordinatorId: string | null,
    dmKey: string | null,
  ): Channel {
    for (const id of assigned) this.available(id);
    if (
      coordinatorId !== null &&
      (!coordinatorId.startsWith("agent:") || !assigned.includes(coordinatorId))
    )
      invalid("Coordinator must be an agent member");
    const now = Date.now();
    const channel: Channel = {
      id: randomUUID(),
      kind: dmKey === null ? "channel" : "dm",
      name,
      members: assigned,
      coordinatorId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare("INSERT INTO channels(id,dm_key,data) VALUES(?,?,?)")
      .run(channel.id, dmKey, JSON.stringify(channel));
    return channel;
  }
  createChannel(input: CreateChannel): Channel {
    plain(input, ["name", "members", "coordinatorId", "idempotencyKey"]);
    const name = str(input.name, "name");
    const assigned = members(input.members);
    const coordinatorId =
      input.coordinatorId == null ? null : member(input.coordinatorId);
    return this.atomic(() =>
      this.idempotent(
        "createChannel",
        input.idempotencyKey,
        { name, members: assigned, coordinatorId },
        () => this.insertChannel(name, assigned, coordinatorId, null),
      ),
    );
  }
  openDm(input: { senderId: string; recipientId: string }): Channel {
    plain(input, ["senderId", "recipientId"]);
    const assigned = members([input.senderId, input.recipientId]);
    const key = JSON.stringify(assigned);
    return this.atomic(() => {
      const prior = this.db
        .prepare("SELECT data FROM channels WHERE dm_key=?")
        .get(key);
      if (prior) return JSON.parse(prior.data as string) as Channel;
      return this.insertChannel("", assigned, null, key);
    });
  }
  getChannel(id: string): Channel {
    return this.read("channels", id);
  }
  updateChannel(id: string, input: UpdateChannel): Channel {
    plain(input, ["expectedRevision", "name", "members", "coordinatorId"]);
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    )
      invalid("Invalid expectedRevision");
    const name = input.name === undefined ? undefined : str(input.name, "name");
    // External identities may be retained or removed, never added by ordinary callers.
    const requestedMembers = input.members;
    const coordinatorId =
      input.coordinatorId === undefined
        ? undefined
        : input.coordinatorId === null
          ? null
          : member(input.coordinatorId);
    return this.atomic(() => {
      const old = this.getChannel(id);
      const assigned =
        requestedMembers === undefined
          ? undefined
          : members(requestedMembers, old.members);
      if (old.revision !== input.expectedRevision)
        conflict("Channel revision conflict");
      if (
        old.kind === "dm" &&
        (assigned !== undefined || coordinatorId !== undefined)
      )
        invalid("DM memberships and coordinator are immutable");
      const nextMembers = assigned ?? old.members;
      for (const id of nextMembers)
        if (!old.members.includes(id)) this.available(id);
      const coordinator =
        coordinatorId === undefined ? old.coordinatorId : coordinatorId;
      if (
        coordinator !== null &&
        (!coordinator.startsWith("agent:") ||
          !nextMembers.includes(coordinator))
      )
        invalid("Coordinator must be an agent member");
      if (coordinator !== null && coordinator !== old.coordinatorId)
        this.available(coordinator);
      const result: Channel = {
        ...old,
        name: name ?? old.name,
        members: nextMembers,
        coordinatorId: coordinator,
        revision: old.revision + 1,
        updatedAt: Date.now(),
      };
      this.db
        .prepare("UPDATE channels SET data=? WHERE id=?")
        .run(JSON.stringify(result), id);
      return result;
    });
  }
  /** Trusted backend setup only: caller verifies provider identity and binding authority. */
  bindExternalConversation(
    input: ExternalConversationBinding,
  ): ExternalConversationBinding {
    const binding = externalBinding(input);
    return this.atomic(() => {
      const key = externalConversationKey(binding);
      const prior = this.db
        .prepare("SELECT data FROM external_conversations WHERE key=?")
        .get(key);
      if (prior) {
        if (prior.data !== JSON.stringify(binding))
          conflict("External conversation mapping conflict");
        return binding;
      }
      const channel = this.getChannel(binding.channelId);
      const recipient = `agent:${binding.profileId}`;
      if (channel.kind !== "channel" || !channel.members.includes(recipient))
        invalid("External recipient must be a channel member");
      this.available(recipient);
      const assigned = [
        ...new Set([
          ...channel.members,
          ...binding.allowedUserIds.map((userId) =>
            externalMemberId({ ...binding, userId }),
          ),
        ]),
      ].sort();
      if (assigned.length > 100) invalid("Too many channel members");
      this.db.prepare("UPDATE channels SET data=? WHERE id=?").run(
        JSON.stringify({
          ...channel,
          members: assigned,
          revision: channel.revision + 1,
          updatedAt: Date.now(),
        }),
        channel.id,
      );
      this.db
        .prepare("INSERT INTO external_conversations VALUES(?,?)")
        .run(key, JSON.stringify(binding));
      return binding;
    });
  }
  /** Read-only reconciliation remains available after revocation. */
  findExternalMessage(input: ExternalProvenance): Message | undefined {
    this.check();
    const provenance = externalProvenance(input);
    const row = this.db
      .prepare("SELECT message_id FROM external_messages WHERE key=?")
      .get(externalMessageKey(provenance));
    if (!row) return undefined;
    const message = this.getMessage(row.message_id as string);
    if (JSON.stringify(message.external) !== JSON.stringify(provenance))
      conflict("External message provenance conflict");
    return message;
  }
  /** Read-only authority check for trusted external file staging and downloads. */
  assertExternalAttachmentScope(
    scope: ChannelAttachmentScope,
    input: ExternalProvenance,
  ): ExternalProvenance {
    this.check();
    plain(scope, ["kind", "channelId", "profileId", "branchId"]);
    if (scope.kind !== "channel" || scope.branchId !== undefined)
      invalid("External attachment branch requires verified mapping");
    const provenance = externalProvenance(input);
    const row = this.db
      .prepare("SELECT data FROM external_conversations WHERE key=?")
      .get(externalConversationKey(provenance));
    if (!row) invalid("External conversation is not bound");
    const binding = JSON.parse(
      row.data as string,
    ) as ExternalConversationBinding;
    if (
      binding.channelId !== scope.channelId ||
      binding.profileId !== scope.profileId ||
      !binding.allowedUserIds.includes(provenance.userId)
    )
      invalid("External attachment scope mismatch");
    const channel = this.getChannel(binding.channelId),
      sender = externalMemberId(provenance),
      recipient = `agent:${binding.profileId}`;
    if (
      !channel.members.includes(sender) ||
      !channel.members.includes(recipient)
    )
      invalid("External sender and recipient must remain channel members");
    this.available(recipient);
    return provenance;
  }
  /** Trusted connector admission. The caller revalidates current binding authority. */
  admitExternalMessage(input: AdmitExternalMessage): Message {
    plain(input, [
      "provenance",
      "text",
      "attachmentIds",
      "replyToNativeMessageId",
    ]);
    const provenance = externalProvenance(input.provenance);
    const attachmentIds = externalAttachmentIds(input.attachmentIds);
    const replyTo =
      input.replyToNativeMessageId === undefined
        ? null
        : str(input.replyToNativeMessageId, "replyToNativeMessageId");
    const text =
      attachmentIds && input.text === "" ? "" : str(input.text, "text", 32000);
    return this.atomic(() => {
      const prior = this.findExternalMessage(provenance);
      if (prior) {
        if (
          prior.text !== text ||
          prior.replyTo !== replyTo ||
          JSON.stringify(prior.attachmentIds) !== JSON.stringify(attachmentIds)
        )
          conflict("External message replay conflict");
        return prior;
      }
      const row = this.db
        .prepare("SELECT data FROM external_conversations WHERE key=?")
        .get(externalConversationKey(provenance));
      if (!row) invalid("External conversation is not bound");
      const binding = JSON.parse(
        row.data as string,
      ) as ExternalConversationBinding;
      if (!binding.allowedUserIds.includes(provenance.userId))
        invalid("External user is not allowed");
      const channel = this.getChannel(binding.channelId);
      const senderId = externalMemberId(provenance);
      const recipientId = `agent:${binding.profileId}`;
      if (
        !channel.members.includes(senderId) ||
        !channel.members.includes(recipientId)
      )
        invalid("External sender and recipient must remain channel members");
      this.available(recipientId);
      const parent = replyTo === null ? null : this.getMessage(replyTo);
      if (parent) {
        if (parent.channelId !== channel.id || parent.branchId !== undefined)
          invalid("External reply must remain in the exact channel and branch");
        const source = this.getMessage(parent.rootId).external;
        if (
          !source ||
          source.provider !== provenance.provider ||
          source.accountId !== provenance.accountId ||
          source.chatId !== provenance.chatId ||
          source.conversationId !== provenance.conversationId ||
          source.bindingId !== provenance.bindingId
        )
          invalid("External reply conversation provenance mismatch");
      }
      let attachments: ChannelAttachmentMetadata[] | undefined;
      if (attachmentIds) {
        if (!this.resolveExternalAttachments)
          throw new MessagingError(
            "unavailable",
            "External attachment resolution unavailable",
          );
        const scope = {
          kind: "channel" as const,
          channelId: channel.id,
          profileId: binding.profileId,
        };
        attachments = externalAttachments(
          this.resolveExternalAttachments(scope, provenance, [
            ...attachmentIds,
          ]),
          scope,
          provenance,
          attachmentIds,
        );
      }
      const id = randomUUID();
      const message: Message = {
        ...(attachments
          ? { attachments, attachmentIds: [...attachmentIds!] }
          : {}),
        id,
        channelId: channel.id,
        senderId,
        recipientId,
        text,
        replyTo,
        rootId: parent?.rootId ?? id,
        hop: parent ? parent.hop + 1 : 0,
        createdAt: Date.now(),
        external: provenance,
      };
      this.insertMessage(message);
      this.db
        .prepare("INSERT INTO external_messages VALUES(?,?)")
        .run(externalMessageKey(provenance), message.id);
      return message;
    });
  }
  postMessage(input: PostMessage): Message {
    plain(input, [
      "channelId",
      "branchId",
      "senderId",
      "recipientId",
      "text",
      "attachmentIds",
      "replyTo",
      "idempotencyKey",
    ]);
    const channelId = str(input.channelId, "channelId");
    const branchId =
      input.branchId == null ? null : str(input.branchId, "branchId");
    const senderId = member(input.senderId);
    const attachmentIds = input.attachmentIds;
    if (
      attachmentIds !== undefined &&
      (!Array.isArray(attachmentIds) ||
        !attachmentIds.length ||
        attachmentIds.length > 16 ||
        new Set(attachmentIds).size !== attachmentIds.length ||
        attachmentIds.some(
          (id) => typeof id !== "string" || !id || id.length > 1024,
        ))
    )
      invalid("Invalid attachment IDs");
    if (
      attachmentIds &&
      (senderId !== "operator" ||
        typeof input.recipientId !== "string" ||
        !input.recipientId.startsWith("agent:"))
    )
      invalid("Attachments require an explicit agent recipient");
    const text =
      attachmentIds && input.text === "" ? "" : str(input.text, "text", 32000);
    const recipientId =
      input.recipientId === undefined
        ? undefined
        : input.recipientId === null
          ? null
          : member(input.recipientId);
    const replyTo =
      input.replyTo === undefined ? null : str(input.replyTo, "replyTo");
    return this.atomic(() =>
      this.idempotent(
        JSON.stringify(["postMessage", channelId, senderId]),
        input.idempotencyKey,
        {
          channelId,
          ...(branchId === null ? {} : { branchId }),
          senderId,
          recipientId,
          text,
          ...(attachmentIds ? { attachmentIds: [...attachmentIds] } : {}),
          replyTo,
        },
        () => {
          let attachments: ChannelAttachmentMetadata[] | undefined;
          if (attachmentIds) {
            if (!this.resolveAttachments)
              throw new MessagingError(
                "unavailable",
                "Attachment resolution unavailable",
              );
            const scope = {
              kind: "channel" as const,
              channelId,
              ...(branchId ? { branchId } : {}),
              profileId: recipientId!.slice(6),
            };
            attachments = this.resolveAttachments(scope, [...attachmentIds]);
            if (
              !Array.isArray(attachments) ||
              attachments.length !== attachmentIds.length ||
              attachments.some(
                (item, index) =>
                  item.id !== attachmentIds[index] ||
                  item.scope.kind !== "channel" ||
                  item.scope.channelId !== channelId ||
                  item.scope.profileId !== scope.profileId ||
                  (item.scope.branchId ?? null) !== branchId,
              )
            )
              invalid("Attachment scope or identity mismatch");
            attachments = structuredClone(attachments);
          }
          return this.post({
            channelId,
            branchId,
            senderId,
            recipientId,
            text,
            ...(attachments
              ? { attachments, attachmentIds: [...attachmentIds!] }
              : {}),
            replyTo,
          });
        },
      ),
    );
  }
  /** Trusted native publisher: caller verifies the retained deployment event and destination. */
  publishDeploymentNotification(input: PublishDeploymentNotification): Message {
    plain(input, [
      "channelId",
      "eventId",
      "deploymentId",
      "connectionId",
      "endpoint",
      "result",
      "occurredAt",
      "name",
      "image",
    ]);
    const channelId = str(input.channelId, "channelId");
    const endpoint = str(input.endpoint, "endpoint", 2048);
    try {
      const url = new URL(endpoint);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        (url.href !== endpoint && url.origin !== endpoint)
      )
        invalid("Invalid deployment endpoint");
    } catch {
      invalid("Invalid deployment endpoint");
    }
    if (!["connectionPublished", "connectionRevoked"].includes(input.result))
      invalid("Invalid deployment result");
    if (
      !Number.isSafeInteger(input.occurredAt) ||
      input.occurredAt <= 0 ||
      input.occurredAt > 8.64e15
    )
      invalid("Invalid deployment event time");
    const source = {
      eventId: str(input.eventId, "eventId"),
      deploymentId: str(input.deploymentId, "deploymentId"),
      connectionId: str(input.connectionId, "connectionId"),
      endpoint,
      result: input.result,
      occurredAt: input.occurredAt,
      name: str(input.name, "name", 1000),
      image: str(input.image, "image", 1024),
    };
    return this.atomic(() =>
      this.idempotent(
        "deploymentNotification",
        source.eventId,
        { channelId, source },
        () => {
          const channel = this.getChannel(channelId);
          if (
            channel.kind !== "channel" ||
            !channel.members.includes("operator")
          )
            invalid("Deployment notification requires an operator channel");
          const id = randomUUID();
          const label =
            source.result === "connectionPublished"
              ? "Connection published"
              : "Connection revoked";
          const message: Message = {
            id,
            channelId,
            senderId: "operator",
            recipientId: null,
            text: `${source.name}: ${label}\n${source.image}`,
            replyTo: null,
            rootId: id,
            hop: 0,
            createdAt: source.occurredAt,
            deploymentNotification: source,
          };
          this.insertMessage(message);
          return message;
        },
      ),
    );
  }
  /** Trusted task publisher: the caller verifies canonical task/discussion ownership. */
  publishTaskDiscussionAnchor(input: PublishTaskDiscussionAnchor): Message {
    plain(input, [
      "channelId",
      "discussionId",
      "taskId",
      "boardId",
      "title",
      "createdAt",
    ]);
    const source = {
      discussionId: str(input.discussionId, "discussionId"),
      taskId: str(input.taskId, "taskId"),
      boardId: str(input.boardId, "boardId"),
    };
    const channelId = str(input.channelId, "channelId");
    const title = str(input.title, "title", 1000);
    const date = str(input.createdAt, "createdAt", 40);
    const createdAt = Date.parse(date);
    if (
      !Number.isFinite(createdAt) ||
      new Date(createdAt).toISOString() !== date
    )
      invalid("Invalid discussion creation time");
    return this.atomic(() =>
      this.idempotent(
        "taskDiscussionAnchor",
        source.discussionId,
        { channelId, source, title, createdAt },
        () => {
          const channel = this.getChannel(channelId);
          if (
            channel.kind !== "channel" ||
            !channel.members.includes("operator")
          )
            invalid("Task discussion requires an operator channel");
          const id = randomUUID();
          const message: Message = {
            id,
            channelId,
            senderId: "operator",
            recipientId: null,
            text: title,
            replyTo: null,
            rootId: id,
            hop: 0,
            createdAt,
            taskDiscussion: source,
          };
          this.insertMessage(message);
          return message;
        },
      ),
    );
  }
  /** Trusted publisher seam: execution outcome comes from the routine store. */
  /** Trusted publication seam: the caller binds the occurrence to its native attempt. */
  publishRoutineOutput(input: PublishRoutineOutput): Message {
    plain(input, [
      "channelId",
      "branchId",
      "profileId",
      "routineId",
      "occurrenceId",
      "state",
      "summary",
      "taskId",
      "attemptId",
      "runId",
      "threadId",
      "outputs",
    ]);
    const channelId = str(input.channelId, "channelId"),
      profileId = str(input.profileId, "profileId", 128);
    const senderId = member(`agent:${profileId}`);
    const branchId =
      input.branchId === undefined
        ? undefined
        : str(input.branchId, "branchId");
    const summary =
      input.summary === "" && input.outputs !== undefined
        ? ""
        : str(input.summary, "summary", 10000);
    if (!["review", "blocked", "cancelled"].includes(input.state))
      invalid("Invalid routine outcome");
    const source = {
      routineId: str(input.routineId, "routineId"),
      occurrenceId: str(input.occurrenceId, "occurrenceId"),
      state: input.state,
      ...(input.taskId === undefined
        ? {}
        : { taskId: str(input.taskId, "taskId") }),
      ...(input.attemptId === undefined
        ? {}
        : { attemptId: str(input.attemptId, "attemptId") }),
    };
    const runId =
      input.runId === undefined ? undefined : str(input.runId, "runId");
    let outputs: TaskOutputMetadata[] | undefined;
    if (input.outputs !== undefined) {
      if (!["review", "blocked"].includes(input.state))
        invalid("Invalid output state");
      try {
        outputs = taskOutputManifest(input.outputs, {
          profileId,
          threadId: str(input.threadId, "threadId"),
          runId: str(runId, "runId"),
          taskId: str(source.taskId, "taskId"),
          attemptId: str(source.attemptId, "attemptId"),
        });
      } catch {
        invalid("Invalid routine output manifest");
      }
    } else if (input.threadId !== undefined)
      invalid("Native output thread requires outputs");
    return this.atomic(() =>
      this.idempotent(
        "routineOutput",
        source.occurrenceId,
        {
          channelId,
          branchId,
          profileId,
          summary,
          source,
          runId,
          ...(outputs ? { outputs } : {}),
        },
        () => {
          const channel = this.getChannel(channelId);
          if (!channel.members.includes(senderId))
            invalid("Routine persona must be a channel member");
          this.available(senderId);
          this.validateBranch(channelId, branchId);
          const id = randomUUID();
          const message: Message = {
            id,
            channelId,
            ...(branchId ? { branchId } : {}),
            senderId,
            recipientId: null,
            text: summary,
            replyTo: null,
            rootId: id,
            hop: 0,
            createdAt: Date.now(),
            routineOutput: source,
            ...(outputs ? { outputs } : {}),
            ...(runId ? { runId } : {}),
          };
          this.insertMessage(message);
          return message;
        },
      ),
    );
  }
  /** Trusted backend seam: the caller authenticates the native run and lease. */
  postAgentMessage(input: PostAgentMessage): Message {
    return this.agentMessage(input, true);
  }
  /** Trusted report publication: mentions are content and never delivery routing. */
  postAgentNotification(input: Omit<PostAgentMessage, "recipientId">): Message {
    return this.agentMessage({ ...input, recipientId: null }, false);
  }
  private agentMessage(
    input: PostAgentMessage,
    interpretMentions: boolean,
  ): Message {
    plain(input, [
      "runId",
      "profileId",
      "channelId",
      "branchId",
      "recipientId",
      "text",
      "replyTo",
      "idempotencyKey",
      "attachmentIds",
    ]);
    const runId = str(input.runId, "runId");
    const profileId = str(input.profileId, "profileId", 128);
    const senderId = member(`agent:${profileId}`);
    const channelId = str(input.channelId, "channelId");
    const attachmentIds = externalAttachmentIds(input.attachmentIds);
    if (
      attachmentIds &&
      this.getChannel(channelId).kind !== "dm" &&
      (typeof input.recipientId !== "string" ||
        !input.recipientId.startsWith("agent:"))
    )
      invalid("Attachment forwarding requires an explicit agent recipient");
    const text =
      attachmentIds && input.text === "" ? "" : str(input.text, "text", 32000);
    const recipientId =
      input.recipientId == null ? input.recipientId : member(input.recipientId);
    const requestedBranch =
      input.branchId == null ? input.branchId : str(input.branchId, "branchId");
    const requestedReply =
      input.replyTo === undefined ? null : str(input.replyTo, "replyTo");
    return this.atomic(() => {
      const source = this.findDeliveryByRun(runId);
      return this.idempotent(
        JSON.stringify([
          interpretMentions ? "postAgentMessage" : "postAgentNotification",
          runId,
        ]),
        input.idempotencyKey,
        {
          runId,
          profileId,
          channelId,
          recipientId,
          text,
          requestedReply,
          requestedBranch,
          ...(attachmentIds ? { attachmentIds } : {}),
          sourceId: source?.id ?? null,
        },
        () => {
          const origin = this.db
            .prepare(
              "SELECT profile_id,root_id FROM origin_run_roots WHERE run_id=?",
            )
            .get(runId);
          if (
            (source && source.profileId !== profileId) ||
            (origin && origin.profile_id !== profileId)
          )
            conflict("Native run profile conflict");
          this.available(senderId);
          const original = source
            ? this.getMessage(source.messageId)
            : undefined;
          const branchId =
            requestedBranch === undefined
              ? original?.channelId === channelId
                ? (original.branchId ?? null)
                : null
              : requestedBranch;
          const replyTo =
            requestedReply ??
            (original?.channelId === channelId &&
            (original.branchId ?? null) === branchId
              ? original.id
              : null);
          const result = this.post(
            { channelId, branchId, senderId, recipientId, text, replyTo },
            {
              runId,
              rootId:
                original?.rootId ?? (origin?.root_id as string | undefined),
              hop: original ? original.hop + 1 : 0,
            },
            interpretMentions,
            attachmentIds
              ? {
                  runId,
                  profileId,
                  attachmentIds,
                  idempotencyKey: input.idempotencyKey,
                }
              : undefined,
          );
          if (!source && !origin)
            this.db
              .prepare("INSERT INTO origin_run_roots VALUES(?,?,?)")
              .run(runId, profileId, result.id);
          return result;
        },
      );
    });
  }
  private post(
    {
      channelId,
      branchId,
      senderId,
      recipientId,
      text,
      attachments,
      attachmentIds,
      replyTo,
    }: Omit<PostMessage, "idempotencyKey" | "replyTo"> & {
      replyTo: string | null;
      attachments?: ChannelAttachmentMetadata[];
    },
    cause?: { runId: string; rootId?: string; hop: number },
    interpretMentions = true,
    forwarding?: Omit<Parameters<AgentAttachmentForwarder>[0], "scope">,
  ): Message {
    const channel = this.getChannel(channelId);
    this.validateBranch(channelId, branchId);
    if (!channel.members.includes(senderId)) invalid("Sender must be a member");
    const mentions = interpretMentions
      ? [
          ...new Set(
            [
              ...text.matchAll(
                /(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9][A-Za-z0-9_-]{0,127})(?![A-Za-z0-9_-])/g,
              ),
            ].map((match) => `agent:${match[1]}`),
          ),
        ]
      : [];
    if (mentions.length > 1) invalid("Multiple agent mentions");
    const mentioned = mentions[0];
    if (mentioned && !channel.members.includes(mentioned))
      invalid("Mention recipient must be a member");
    if (
      recipientId !== undefined &&
      recipientId !== null &&
      mentioned &&
      mentioned !== recipientId
    )
      conflict("Explicit recipient and mention conflict");
    const others = channel.members.filter(
      (id) => id !== senderId && id.startsWith("agent:"),
    );
    const target =
      recipientId !== undefined
        ? recipientId
        : (mentioned ??
          (channel.kind === "dm"
            ? channel.members.find((id) => id !== senderId)
            : (channel.coordinatorId ??
              (others.length === 1 ? others[0] : null))) ??
          null);
    if (target === null && recipientId !== null)
      invalid("Ambiguous recipient; specify a recipient or explicit broadcast");
    if (target !== null) {
      if (!channel.members.includes(target))
        invalid("Recipient must be a member");
      if (target === senderId) invalid("No self delivery");
      this.available(target);
    }
    const parent = replyTo === null ? null : this.getMessage(replyTo);
    if (
      parent &&
      (parent.channelId !== channelId ||
        (parent.branchId ?? null) !== (branchId ?? null))
    )
      invalid("Reply must belong to same channel and branch");
    const hop = cause ? cause.hop : parent ? parent.hop + 1 : 0;
    if (senderId.startsWith("agent:") && hop > 8)
      invalid("Agent reply hop limit exceeded");
    if (forwarding) {
      if (!target?.startsWith("agent:"))
        invalid("Attachment recipient must be an agent");
      if (!this.forwardAgentAttachments)
        throw new MessagingError(
          "unavailable",
          "Attachment forwarding unavailable",
        );
      const scope: ChannelAttachmentScope = {
        kind: "channel",
        channelId,
        profileId: target.slice(6),
        ...(branchId == null ? {} : { branchId }),
      };
      const admitted = this.forwardAgentAttachments({ ...forwarding, scope });
      if (
        !Array.isArray(admitted) ||
        admitted.length !== forwarding.attachmentIds.length ||
        new Set(admitted.map((file) => file.id)).size !== admitted.length ||
        admitted.some(
          (file) =>
            !file.id ||
            file.scope.kind !== "channel" ||
            file.scope.channelId !== channelId ||
            file.scope.profileId !== scope.profileId ||
            (file.scope.branchId ?? null) !== (branchId ?? null),
        )
      )
        invalid("Forwarded attachment scope or identity mismatch");
      attachments = structuredClone(admitted);
      attachmentIds = admitted.map((file) => file.id);
    }
    const id = randomUUID();
    const message: Message = {
      id,
      channelId,
      ...(branchId == null ? {} : { branchId }),
      senderId,
      recipientId: target,
      text,
      ...(attachments ? { attachments, attachmentIds } : {}),
      replyTo,
      rootId: cause ? (cause.rootId ?? id) : (parent?.rootId ?? id),
      ...(cause ? { runId: cause.runId } : {}),
      hop,
      createdAt: Date.now(),
    };
    this.insertMessage(message);
    return message;
  }
  private insertMessage(message: Message): void {
    this.db
      .prepare("INSERT INTO messages(id,channel_id,data) VALUES(?,?,?)")
      .run(message.id, message.channelId, JSON.stringify(message));
    this.insertDelivery(message);
  }
  private insertDelivery(message: Message): void {
    if (!message.recipientId?.startsWith("agent:")) return;
    if (this.db.prepare("SELECT 1 FROM deliveries WHERE id=?").get(message.id))
      return;
    let reason: string | undefined;
    if (message.hop >= 8) reason = "Agent reply hop limit reached";
    else {
      this.db
        .prepare("INSERT OR IGNORE INTO causal_budgets VALUES(?,0)")
        .run(message.rootId);
      const reservation = this.db
        .prepare(
          "UPDATE causal_budgets SET admitted=admitted+1 WHERE root_id=? AND admitted<32",
        )
        .run(message.rootId);
      if (reservation.changes === 0)
        reason = "Causal delivery budget reached (32)";
    }
    const delivery: Delivery = {
      id: message.id,
      messageId: message.id,
      channelId: message.channelId,
      ...(message.branchId ? { branchId: message.branchId } : {}),
      profileId: message.recipientId.slice(6),
      state: reason ? "blocked" : "queued",
      createdAt: message.createdAt,
      ...(reason
        ? {
            reason,
            endedAt: message.createdAt,
          }
        : {}),
    };
    this.db
      .prepare(
        "INSERT OR IGNORE INTO deliveries(id,channel_id,data) VALUES(?,?,?)",
      )
      .run(delivery.id, delivery.channelId, JSON.stringify(delivery));
  }
  private saveDelivery(delivery: Delivery): Delivery {
    this.db
      .prepare("UPDATE deliveries SET data=? WHERE id=?")
      .run(JSON.stringify(delivery), delivery.id);
    return delivery;
  }
  getDelivery(id: string): Delivery {
    return this.read("deliveries", id);
  }
  findReplyDelivery(
    messageId: string,
    profileId: string,
  ): Delivery | undefined {
    this.check();
    str(messageId, "messageId");
    str(profileId, "profileId");
    const rows = this.db
      .prepare(
        "SELECT data FROM deliveries WHERE json_extract(data,'$.profileId')=? AND json_extract(data,'$.messageId')=? UNION SELECT data FROM deliveries WHERE json_extract(data,'$.profileId')=? AND json_extract(data,'$.replyMessageId')=? LIMIT 2",
      )
      .all(profileId, messageId, profileId, messageId);
    if (rows.length > 1) conflict("Ambiguous message delivery provenance");
    return rows[0] ? (JSON.parse(String(rows[0].data)) as Delivery) : undefined;
  }
  listChildBranches(
    channelId: string,
    input: PageInput & { branchId?: string } = {},
  ): Page<ChannelBranch> {
    plain(input, ["after", "limit", "branchId"]);
    this.getChannel(channelId);
    const parent =
      input.branchId === undefined ? null : str(input.branchId, "branchId");
    this.validateBranch(channelId, parent);
    return this.page(
      "branches",
      JSON.stringify(["child-branches", channelId, parent]),
      input,
      "AND channel_id=? AND " +
        (parent === null
          ? "json_extract(data,'$.parentBranchId') IS NULL"
          : "json_extract(data,'$.parentBranchId')=?"),
      parent === null ? [channelId] : [channelId, parent],
    );
  }
  branchMessageSummary(branchId: string) {
    const branch = this.getBranch(branchId);
    const rows = this.db
      .prepare(
        "SELECT json_extract(data,'$.senderId') AS participant, COUNT(*) AS count FROM messages WHERE channel_id=? AND json_extract(data,'$.branchId')=? GROUP BY participant ORDER BY participant",
      )
      .all(branch.channelId, branchId);
    const externalParticipants = this.db
      .prepare(
        "SELECT DISTINCT json_extract(data,'$.senderId') AS member_id,json_extract(data,'$.external.provider') AS provider,json_extract(data,'$.external.accountId') AS account_id,json_extract(data,'$.external.userId') AS user_id FROM messages WHERE channel_id=? AND json_extract(data,'$.branchId')=? AND json_type(data,'$.external')='object' ORDER BY member_id",
      )
      .all(branch.channelId, branchId)
      .map((row) => {
        const identity = {
          provider: row.provider as ExternalProvenance["provider"],
          accountId: row.account_id as string,
          userId: row.user_id as string,
        };
        const memberId = externalMemberId(identity);
        if (memberId !== row.member_id)
          conflict("External participant provenance mismatch");
        return { memberId, ...identity };
      });
    return {
      messageCount: rows.reduce((sum, row) => sum + Number(row.count), 0),
      participants: rows.map((row) => String(row.participant)),
      ...(externalParticipants.length ? { externalParticipants } : {}),
    };
  }
  findDeliveryByRun(runId: string): Delivery | undefined {
    this.check();
    str(runId, "runId");
    const row = this.db
      .prepare(
        "SELECT data FROM deliveries WHERE json_extract(data,'$.runId')=?",
      )
      .get(runId);
    return row ? (JSON.parse(row.data as string) as Delivery) : undefined;
  }
  private validateBranch(channelId: string, branchId?: string | null): void {
    if (branchId != null && this.getBranch(branchId).channelId !== channelId)
      invalid("Branch must belong to channel");
  }
  createBranch(input: CreateBranch): ChannelBranch {
    plain(input, [
      "channelId",
      "name",
      "parentBranchId",
      "parentMessageId",
      "idempotencyKey",
    ]);
    const parentMessageId =
      input.parentMessageId === undefined
        ? undefined
        : str(input.parentMessageId, "parentMessageId");
    const channelId = str(input.channelId, "channelId");
    const name = str(input.name, "name");
    const parentBranchId =
      input.parentBranchId == null
        ? null
        : str(input.parentBranchId, "parentBranchId");
    return this.atomic(() =>
      this.idempotent(
        "createBranch",
        input.idempotencyKey,
        {
          channelId,
          name,
          parentBranchId,
          ...(parentMessageId ? { parentMessageId } : {}),
        },
        () => {
          this.getChannel(channelId);
          this.validateBranch(channelId, parentBranchId);
          if (parentMessageId) {
            const message = this.getMessage(parentMessageId);
            if (message.taskDiscussion)
              invalid("Task discussion anchors are not OMP checkpoint parents");
            if (
              message.channelId !== channelId ||
              (message.branchId ?? null) !== parentBranchId
            )
              invalid("Reply parent must belong to exact channel branch");
          }
          const result: ChannelBranch = {
            ...(parentMessageId ? { parentMessageId } : {}),
            id: randomUUID(),
            channelId,
            name,
            parentBranchId,
            createdAt: Date.now(),
          };
          this.db
            .prepare("INSERT INTO branches(id,channel_id,data) VALUES(?,?,?)")
            .run(result.id, channelId, JSON.stringify(result));
          return result;
        },
      ),
    );
  }
  getBranch(id: string): ChannelBranch {
    return this.read("branches", id);
  }
  listBranches(channelId: string, input: PageInput = {}): Page<ChannelBranch> {
    plain(input, ["after", "limit"]);
    this.getChannel(channelId);
    return this.page(
      "branches",
      JSON.stringify(["branches", channelId]),
      input,
      "AND channel_id=?",
      [channelId],
    );
  }
  beginBranchFork(input: BeginBranchFork): BranchFork {
    plain(input, [
      "branchId",
      "profileId",
      "parentThreadId",
      "entryId",
      "idempotencyKey",
      "replyToRunId",
      "replyToRole",
    ]);
    const branchId = str(input.branchId, "branchId");
    const profileId = str(input.profileId, "profileId", 128);
    const identity = member(`agent:${profileId}`);
    const parentThreadId = str(input.parentThreadId, "parentThreadId");
    const entryId = str(input.entryId, "entryId");
    const replyToRunId =
      input.replyToRunId === undefined
        ? undefined
        : str(input.replyToRunId, "replyToRunId");
    if (
      input.replyToRole !== undefined &&
      (!replyToRunId || !["user", "assistant"].includes(input.replyToRole))
    )
      invalid("Invalid reply role");
    const reply = replyToRunId
      ? {
          replyToRunId,
          replyToRole: input.replyToRole ?? ("assistant" as const),
        }
      : {};
    return this.atomic(() => {
      const id = this.idempotent(
        "beginBranchFork",
        input.idempotencyKey,
        { branchId, profileId, parentThreadId, entryId, ...reply },
        () => {
          const branch = this.getBranch(branchId);
          const channel = this.getChannel(branch.channelId);
          if (!channel.members.includes(identity))
            invalid("Profile must be a channel member");
          this.available(identity);
          if (
            this.getConversation(
              channel.id,
              profileId,
              branch.parentBranchId ?? undefined,
            )?.threadId !== parentThreadId
          )
            conflict("Parent conversation does not match native thread");
          if (
            this.getConversation(channel.id, profileId, branchId) ||
            this.db
              .prepare(
                "SELECT 1 FROM branch_forks WHERE branch_id=? AND json_extract(data,'$.profileId')=? AND json_extract(data,'$.state')!='cancelled'",
              )
              .get(branchId, profileId)
          )
            conflict("Branch profile already mapped or pending");
          const result: BranchFork = {
            ...reply,
            id: randomUUID(),
            branchId,
            channelId: channel.id,
            profileId,
            parentThreadId,
            entryId,
            state: "pending",
            createdAt: Date.now(),
          };
          this.db
            .prepare(
              "INSERT INTO branch_forks(id,branch_id,data) VALUES(?,?,?)",
            )
            .run(result.id, branchId, JSON.stringify(result));
          return result.id;
        },
      );
      return this.getBranchFork(id);
    });
  }
  getBranchFork(id: string): BranchFork {
    return this.read("branch_forks", id);
  }
  listBranchForks(
    branchId: string | undefined,
    input: PageInput = {},
  ): Page<BranchFork> {
    plain(input, ["after", "limit"]);
    if (branchId !== undefined) this.getBranch(branchId);
    return this.page(
      "branch_forks",
      JSON.stringify(["branch_forks", branchId ?? null]),
      input,
      branchId === undefined ? "" : "AND branch_id=?",
      branchId === undefined ? [] : [branchId],
    );
  }
  completeBranchFork(
    id: string,
    input: { forkOperationId: string; threadId: string },
  ): BranchFork {
    plain(input, ["forkOperationId", "threadId"]);
    const forkOperationId = str(input.forkOperationId, "forkOperationId");
    const threadId = str(input.threadId, "threadId");
    return this.atomic(() => {
      const prior = this.getBranchFork(id);
      if (
        prior.state === "completed" &&
        prior.forkOperationId === forkOperationId &&
        prior.threadId === threadId
      )
        return prior;
      if (prior.state !== "pending")
        conflict("Branch fork completion conflict");
      this.bindConversationInTransaction(
        prior.channelId,
        prior.profileId,
        threadId,
        prior.branchId,
      );
      const result: BranchFork = {
        ...prior,
        state: "completed",
        forkOperationId,
        threadId,
      };
      this.db
        .prepare("UPDATE branch_forks SET data=? WHERE id=?")
        .run(JSON.stringify(result), id);
      return result;
    });
  }
  cancelBranchFork(
    id: string,
    input: { forkOperationId: string; reason: string },
  ): BranchFork {
    plain(input, ["forkOperationId", "reason"]);
    const forkOperationId = str(input.forkOperationId, "forkOperationId");
    const reason = str(input.reason, "reason", 32000);
    return this.atomic(() => {
      const prior = this.getBranchFork(id);
      if (
        prior.state === "cancelled" &&
        prior.forkOperationId === forkOperationId &&
        prior.reason === reason
      )
        return prior;
      if (prior.state !== "pending")
        conflict("Branch fork cancellation conflict");
      const result: BranchFork = {
        ...prior,
        state: "cancelled",
        forkOperationId,
        reason,
      };
      this.db
        .prepare("UPDATE branch_forks SET data=? WHERE id=?")
        .run(JSON.stringify(result), id);
      return result;
    });
  }
  getConversation(
    channelId: string,
    profileId: string,
    branchId?: string,
  ): Conversation | null {
    this.check();
    str(channelId, "channelId");
    str(profileId, "profileId", 128);
    member(`agent:${profileId}`);
    this.validateBranch(channelId, branchId);
    const row =
      branchId === undefined
        ? this.db
            .prepare(
              "SELECT thread_id FROM conversations WHERE channel_id=? AND profile_id=?",
            )
            .get(channelId, profileId)
        : this.db
            .prepare(
              "SELECT thread_id FROM branch_conversations WHERE branch_id=? AND profile_id=?",
            )
            .get(branchId, profileId);
    return row
      ? {
          channelId,
          profileId,
          threadId: row.thread_id as string,
          ...(branchId ? { branchId } : {}),
        }
      : null;
  }
  listConversations(
    channelId: string,
    input: PageInput & { branchId?: string } = {},
  ): Page<Conversation> {
    plain(input, ["branchId", "after", "limit"]);
    this.getChannel(channelId);
    this.validateBranch(channelId, input.branchId);
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      invalid("Invalid page limit");
    const scope = JSON.stringify([
      "conversations",
      channelId,
      input.branchId ?? null,
    ]);
    let after = "";
    if (input.after !== undefined) {
      try {
        const decoded = JSON.parse(
          Buffer.from(str(input.after, "cursor", 1000), "base64url").toString(),
        ) as unknown;
        if (
          !Array.isArray(decoded) ||
          decoded.length !== 2 ||
          decoded[0] !== scope
        )
          invalid("Invalid cursor");
        after = str(decoded[1], "cursor profile", 128);
      } catch {
        invalid("Invalid cursor");
      }
    }
    const rows =
      input.branchId === undefined
        ? this.db
            .prepare(
              "SELECT profile_id,thread_id FROM conversations WHERE channel_id=? AND profile_id>? ORDER BY profile_id LIMIT ?",
            )
            .all(channelId, after, limit + 1)
        : this.db
            .prepare(
              "SELECT profile_id,thread_id FROM branch_conversations WHERE branch_id=? AND profile_id>? ORDER BY profile_id LIMIT ?",
            )
            .all(input.branchId, after, limit + 1);
    const items = rows.slice(0, limit).map((row) => ({
      channelId,
      profileId: row.profile_id as string,
      threadId: row.thread_id as string,
      ...(input.branchId ? { branchId: input.branchId } : {}),
    }));
    return {
      items,
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              JSON.stringify([scope, items.at(-1)!.profileId]),
            ).toString("base64url")
          : null,
    };
  }
  private bindConversationInTransaction(
    channelId: string,
    profileId: string,
    threadId: string,
    branchId?: string,
  ): Conversation {
    const prior = this.getConversation(channelId, profileId, branchId);
    if (prior) {
      if (prior.threadId !== threadId) conflict("Conversation thread conflict");
      return prior;
    }
    this.getChannel(channelId);
    if (branchId === undefined)
      this.db
        .prepare("INSERT INTO conversations VALUES(?,?,?)")
        .run(channelId, profileId, threadId);
    else
      this.db
        .prepare("INSERT INTO branch_conversations VALUES(?,?,?)")
        .run(branchId, profileId, threadId);
    return {
      channelId,
      profileId,
      threadId,
      ...(branchId ? { branchId } : {}),
    };
  }
  bindConversation(
    channelId: string,
    profileId: string,
    threadId: string,
    branchId?: string,
  ): Conversation {
    str(threadId, "threadId");
    return this.atomic(() =>
      this.bindConversationInTransaction(
        channelId,
        profileId,
        threadId,
        branchId,
      ),
    );
  }
  bindDeliveryThread(id: string, threadId: string): Delivery {
    str(threadId, "threadId");
    return this.atomic(() => {
      const prior = this.getDelivery(id);
      if (prior.threadId === threadId) return prior;
      if (prior.threadId || prior.state !== "queued")
        conflict("Delivery thread conflict");
      return this.saveDelivery({ ...prior, threadId });
    });
  }
  bindDeliveryRun(id: string, runId: string): Delivery {
    str(runId, "runId");
    return this.atomic(() => {
      const prior = this.getDelivery(id);
      if (prior.runId === runId) return prior;
      if (prior.runId || !prior.threadId || prior.state !== "queued")
        conflict("Delivery run conflict");
      if (
        this.findDeliveryByRun(runId) ||
        this.db
          .prepare("SELECT 1 FROM origin_run_roots WHERE run_id=?")
          .get(runId)
      )
        conflict("Native run already bound");
      return this.saveDelivery({ ...prior, runId, state: "running" });
    });
  }
  private endQueuedDelivery(
    id: string,
    state: "blocked" | "cancelled",
    reason: string,
  ): Delivery {
    str(reason, "reason", 32000);
    return this.atomic(() => {
      const prior = this.getDelivery(id);
      if (prior.state === state && prior.reason === reason && !prior.runId)
        return prior;
      if (prior.state !== "queued") conflict("Delivery is not queued");
      return this.saveDelivery({
        ...prior,
        state,
        reason,
        endedAt: Date.now(),
      });
    });
  }
  blockDelivery(id: string, reason: string): Delivery {
    return this.endQueuedDelivery(id, "blocked", reason);
  }
  cancelQueuedDelivery(id: string, reason: string): Delivery {
    return this.endQueuedDelivery(id, "cancelled", reason);
  }
  requestCancelDelivery(id: string): Delivery {
    return this.atomic(() => {
      const prior = this.getDelivery(id);
      if (prior.state === "queued")
        return this.saveDelivery({
          ...prior,
          state: "cancelled",
          reason: "Cancelled by operator before admission",
          endedAt: Date.now(),
        });
      if (
        prior.state !== "running" ||
        prior.cancellationRequestedAt !== undefined
      )
        return prior;
      return this.saveDelivery({
        ...prior,
        cancellationRequestedAt: Date.now(),
      });
    });
  }
  reconcileDelivery(
    id: string,
    input: { runId: string; reason: string },
  ): Delivery {
    plain(input, ["runId", "reason"]);
    const runId = str(input.runId, "runId");
    const reason = str(input.reason, "reason", 32000);
    return this.atomic(() =>
      this.idempotent("reconcileDelivery", id, { runId, reason }, () => {
        const prior = this.getDelivery(id);
        if (prior.runId !== runId || prior.state !== "attention_required")
          conflict("Delivery reconciliation conflict");
        return this.saveDelivery({
          ...prior,
          state: "cancelled",
          reason,
          endedAt: Date.now(),
        });
      }),
    );
  }
  finishDelivery(id: string, input: FinishDelivery): Delivery {
    plain(input, [
      "runId",
      "state",
      "output",
      "outputTruncated",
      "reason",
      "conversationOutputs",
    ]);
    const runId = str(input.runId, "runId");
    const { state, output, outputTruncated } = input;
    if (
      !["completed", "failed", "cancelled", "attention_required"].includes(
        state,
      )
    )
      invalid("Invalid terminal state");
    if (
      typeof output !== "string" ||
      output.length > 32000 ||
      typeof outputTruncated !== "boolean"
    )
      invalid("Invalid delivery output");
    const reason =
      input.reason === undefined
        ? undefined
        : str(input.reason, "reason", 32000);
    const delivery = this.getDelivery(id);
    if (
      input.conversationOutputs !== undefined &&
      (state !== "completed" || !delivery.threadId)
    )
      invalid("Conversation files require a completed bound native run");
    const conversationOutputs =
      input.conversationOutputs === undefined
        ? undefined
        : conversationOutputManifest(input.conversationOutputs, {
            profileId: delivery.profileId,
            threadId: delivery.threadId!,
            runId,
            channelId: delivery.channelId,
            ...(delivery.branchId ? { branchId: delivery.branchId } : {}),
          });
    return this.atomic(() =>
      this.idempotent(
        "finishDelivery",
        id,
        {
          runId,
          state,
          output,
          outputTruncated,
          reason,
          ...(conversationOutputs ? { conversationOutputs } : {}),
        },
        () => {
          const prior = this.getDelivery(id);
          if (prior.runId !== runId || prior.state !== "running")
            conflict("Delivery completion run conflict");
          const endedAt = Date.now();
          const result: Delivery = {
            ...prior,
            state,
            output,
            outputTruncated,
            ...(reason === undefined ? {} : { reason }),
            endedAt,
          };
          if (
            state === "completed" &&
            (output.length > 0 || conversationOutputs?.length)
          ) {
            const original = this.getMessage(prior.messageId);
            const reply: Message = {
              ...(conversationOutputs ? { conversationOutputs } : {}),
              id: randomUUID(),
              channelId: original.channelId,
              ...(original.branchId ? { branchId: original.branchId } : {}),
              senderId: `agent:${prior.profileId}`,
              recipientId: original.senderId,
              text: output,
              replyTo: original.id,
              rootId: original.rootId,
              hop: original.hop + 1,
              runId,
              ...(outputTruncated ? { truncated: true as const } : {}),
              createdAt: endedAt,
            };
            this.insertMessage(reply);
            result.replyMessageId = reply.id;
          }
          return this.saveDelivery(result);
        },
      ),
    );
  }
  listDeliveries(
    input: PageInput & {
      channelId?: string;
      branchId?: string | null;
      states?: Delivery["state"][];
    } = {},
  ): Page<Delivery> {
    plain(input, ["after", "limit", "channelId", "branchId", "states"]);
    const branchId =
      input.branchId == null ? input.branchId : str(input.branchId, "branchId");
    if (branchId)
      this.validateBranch(
        input.channelId ?? this.getBranch(branchId).channelId,
        branchId,
      );
    const channelId =
      input.channelId === undefined
        ? undefined
        : str(input.channelId, "channelId");
    const valid = [
      "queued",
      "running",
      "completed",
      "failed",
      "cancelled",
      "attention_required",
      "blocked",
    ];
    if (input.states !== undefined) {
      const values = input.states;
      if (
        !Array.isArray(values) ||
        Object.getPrototypeOf(values) !== Array.prototype ||
        values.length > valid.length ||
        Reflect.ownKeys(values).some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) ||
            !("value" in Object.getOwnPropertyDescriptor(values, key)!),
        )
      )
        invalid("Invalid delivery states");
      for (let i = 0; i < values.length; i++)
        if (!valid.includes(values[i]!)) invalid("Invalid delivery states");
    }
    const states =
      input.states === undefined
        ? undefined
        : [...new Set(input.states)].sort();
    const filters: string[] = [];
    const parameters: string[] = [];
    if (channelId !== undefined) {
      filters.push("AND channel_id=?");
      parameters.push(channelId);
    }
    if (branchId !== undefined) {
      filters.push(
        branchId === null
          ? "AND json_extract(data,'$.branchId') IS NULL"
          : "AND json_extract(data,'$.branchId')=?",
      );
      if (branchId !== null) parameters.push(branchId);
    }
    if (states !== undefined) {
      filters.push(
        `AND json_extract(data,'$.state') IN (${states.map(() => "?").join(",")})`,
      );
      parameters.push(...states);
    }
    return this.page(
      "deliveries",
      JSON.stringify([
        "deliveries",
        channelId ?? null,
        states ?? null,
        branchId === undefined ? "all" : branchId,
      ]),
      input,
      filters.join(" "),
      parameters,
    );
  }
  getMessage(id: string): Message {
    return this.read("messages", id);
  }
  private page<T>(
    table: "channels" | "messages" | "deliveries" | "branches" | "branch_forks",
    scope: string,
    input: PageInput,
    filter: string,
    parameters: string[],
  ): Page<T> {
    this.check();
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      invalid("Invalid page limit");
    let seq = 0;
    if (input.after !== undefined) {
      const cursor = str(input.after, "cursor", 1000);
      try {
        const decoded = JSON.parse(
          Buffer.from(cursor, "base64url").toString(),
        ) as unknown;
        if (
          !Array.isArray(decoded) ||
          decoded.length !== 2 ||
          decoded[0] !== scope ||
          !Number.isSafeInteger(decoded[1]) ||
          decoded[1] < 1
        )
          invalid("Invalid cursor");
        seq = decoded[1];
      } catch {
        invalid("Invalid cursor");
      }
    }
    const rows = this.db
      .prepare(
        `SELECT seq,data FROM ${table} WHERE seq>? ${filter} ORDER BY seq LIMIT ?`,
      )
      .all(seq, ...parameters, limit + 1);
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => JSON.parse(row.data as string) as T),
      nextCursor:
        rows.length > limit
          ? Buffer.from(JSON.stringify([scope, page.at(-1)!.seq])).toString(
              "base64url",
            )
          : null,
    };
  }
  listChannels(
    input: PageInput & { memberId?: string; kind?: "dm" | "channel" } = {},
  ): Page<Channel> {
    plain(input, ["after", "limit", "memberId", "kind"]);
    if (
      input.kind !== undefined &&
      input.kind !== "dm" &&
      input.kind !== "channel"
    )
      invalid("Invalid channel kind");
    const id =
      input.memberId === undefined ? undefined : member(input.memberId);
    return this.page(
      "channels",
      JSON.stringify(["channels", id ?? null, input.kind ?? null]),
      input,
      (id === undefined
        ? ""
        : "AND EXISTS(SELECT 1 FROM json_each(channels.data,'$.members') WHERE value=?)") +
        (input.kind === undefined ? "" : " AND json_extract(data,'$.kind')=?"),
      [
        ...(id === undefined ? [] : [id]),
        ...(input.kind === undefined ? [] : [input.kind]),
      ],
    );
  }
  listMessages(
    channelId: string,
    input: PageInput & { branchId?: string | null } = {},
  ): Page<Message> {
    plain(input, ["after", "limit", "branchId"]);
    this.getChannel(channelId);
    const branchId = input.branchId ?? null;
    this.validateBranch(channelId, branchId);
    return this.page(
      "messages",
      JSON.stringify(["messages", channelId, branchId]),
      input,
      "AND channel_id=? AND " +
        (branchId === null
          ? "json_extract(data,'$.branchId') IS NULL"
          : "json_extract(data,'$.branchId')=?"),
      branchId === null ? [channelId] : [channelId, branchId],
    );
  }
}
