import type { InteractionHistoryInput } from "./interaction-history.js";
import { historicalAttachment } from "./historical-attachments.js";
import {
  conversationOutputContext,
  conversationOutputPaths,
  admittedConversationOutputs,
  type ConversationOutputContext,
  type ConversationOutputScope,
  type ConversationOutputMetadata,
  type ConversationOutputAcquisition,
} from "./conversation-outputs.js";
import {
  taskOutputPaths,
  admittedTaskOutputs,
  type TaskOutputAcquisition,
  type TaskOutputScope,
} from "./task-outputs.js";
import {
  assertAttachmentBudget,
  attachmentIds,
  attachmentSources,
  metadata,
  resolveAttachments,
  sameAttachments,
  type AttachmentResolver,
} from "./attachments.js";
import { threadWork } from "./thread-work.js";
import { ForkStore } from "./fork-store.js";
import { replyPrompt } from "./reply-context.js";
import { threadSummary } from "./thread-summary.js";
import { InteractionStore } from "./interaction-store.js";
import { ProfileStore } from "./profile-store.js";
import { runtimeActivity, type ActivityInput } from "./runtime-activity.js";
import {
  RuntimeHistoryPages,
  type HistoryPageInput,
  type ThreadPageInput,
} from "./history-pages.js";
export type {
  HistoryPage,
  HistoryPageInput,
  ThreadPageInput,
} from "./history-pages.js";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  RuntimeError,
  isApprovalMode,
  type AgentProfile,
  type AgentWorker,
  type Thread,
  type ThreadOwner,
  type Run,
  type RunEvent,
  type RunEventData,
  type TurnInput,
  type WorkerInput,
  type WorkerEvent,
  type BranchPoint,
  type CreateProfileInput,
  type UpdateProfileInput,
  type InteractionResponse,
  type TaskOutcome,
  type ForkOperation,
  type ReplyContext,
} from "./types.js";
export interface RuntimeOptions {
  conversationOutputs?: ConversationOutputAcquisition;
  taskOutputs?: TaskOutputAcquisition;
  databasePath: string;
  profiles: AgentProfile[];
  worker: AgentWorker;
  resolveAttachments?: AttachmentResolver;
}
export class AgentRuntime {
  private readonly db: DatabaseSync;
  private readonly forkStore: ForkStore;
  private readonly profileStore: ProfileStore;
  private readonly interactionStore: InteractionStore;
  private readonly historyPages: RuntimeHistoryPages;
  private readonly profiles = new Map<string, AgentProfile>();
  private closed = false;
  private closing = false;
  private storageFailed = false;
  private shutdown?: Promise<void>;
  private readonly branches = new Map<
    string,
    { controller: AbortController; done: Promise<unknown> }
  >();
  private readonly ownerId = randomUUID();
  private readonly active = new Map<
    string,
    { controller: AbortController; done: Promise<Run> }
  >();
  constructor(private readonly options: RuntimeOptions) {
    for (const profile of options.profiles) {
      if (
        !/^[a-z][a-z0-9_-]{0,63}$/.test(profile.id) ||
        this.profiles.has(profile.id) ||
        (profile.approvalMode !== undefined &&
          !isApprovalMode(profile.approvalMode)) ||
        !profile.instructions.trim() ||
        !profile.modelIds.includes(profile.defaultModelId)
      )
        throw new RuntimeError("invalid", "Invalid or duplicate agent profile");
      this.profiles.set(profile.id, {
        ...structuredClone(profile),
        approvalMode: profile.approvalMode ?? "always-ask",
      });
    }
    this.db = new DatabaseSync(options.databasePath);
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()?.user_version,
    );
    if (version > 8) {
      this.db.close();
      throw new RuntimeError(
        "unavailable",
        "Unsupported database schema version",
      );
    }
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;",
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), request_key TEXT NOT NULL, input TEXT NOT NULL, value TEXT NOT NULL, worker_pid INTEGER) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS run_request ON runs(thread_id,request_key);
      CREATE TABLE IF NOT EXISTS events (run_id TEXT NOT NULL REFERENCES runs(id), sequence INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(run_id,sequence)) STRICT;`);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, pid INTEGER NOT NULL) STRICT;",
    );
    this.forkStore = new ForkStore(this.db);
    this.historyPages = new RuntimeHistoryPages(this.db);
    this.interactionStore = new InteractionStore(
      this.db,
      (operation) => this.transaction(operation),
      (runId, event) => this.appendEvent(runId, event),
      () => this.failStorage(),
    );
    try {
      this.profileStore = this.transaction(() => {
        const previous = this.db
          .prepare("SELECT id,pid FROM owner WHERE singleton=1")
          .get();
        if (previous && this.isAlive(Number(previous.pid)))
          throw new RuntimeError(
            "conflict",
            "Database already has a live runtime owner",
          );
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT; PRAGMA user_version=2;",
        );
        this.interactionStore.migrate(version < 8);
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS thread_requests (key TEXT PRIMARY KEY, profile_id TEXT NOT NULL, thread_id TEXT NOT NULL UNIQUE REFERENCES threads(id)) STRICT; PRAGMA user_version=4;",
        );
        this.forkStore.migrate();
        this.historyPages.migrate();
        this.db.exec("PRAGMA user_version=8");
        this.forkStore.recover();
        this.interactionStore.recover();
        this.db
          .prepare(
            "INSERT OR REPLACE INTO owner(singleton,id,pid) VALUES (1,?,?)",
          )
          .run(this.ownerId, process.pid);
        for (const row of this.db
          .prepare(
            "SELECT id,value,worker_pid FROM runs WHERE json_extract(value,'$.state') IN ('running','attention_required')",
          )
          .all()) {
          const run = JSON.parse(String(row.value)) as Run;
          const uncertain =
            run.errorCode === "cleanup_uncertain" ||
            run.workerOwnership === "guardian" ||
            row.worker_pid === null ||
            this.workerAlive(Number(row.worker_pid));
          run.state = uncertain ? "attention_required" : "interrupted";
          if (!uncertain) {
            run.endedAt = new Date().toISOString();
            run.errorCode = "interrupted";
          }
          this.db
            .prepare("UPDATE runs SET value=? WHERE id=?")
            .run(JSON.stringify(run), run.id);
          this.appendEvent(run.id, { type: "state", state: run.state });
        }
        return new ProfileStore(this.db, this.profiles, options.profiles);
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  createProfile(input: CreateProfileInput) {
    this.assertOpen();
    return this.profileStore.create(input);
  }
  updateProfile(id: string, input: UpdateProfileInput) {
    this.assertOpen();
    return this.profileStore.update(id, input);
  }
  hasProfileIdentity(id: string): boolean {
    this.assertOpen();
    return this.profileStore.hasIdentity(id);
  }
  getProfile(id: string) {
    this.assertOpen();
    return this.profileStore.get(id);
  }
  deleteProfile(id: string, expectedRevision: string): void {
    this.assertOpen();
    this.profileStore.get(id);
    for (const row of this.db
      .prepare(
        "SELECT id FROM threads WHERE json_extract(value,'$.profileId')=?",
      )
      .all(id)) {
      const threadId = String(row.id);
      if (
        this.branches.has(threadId) ||
        this.db
          .prepare(
            "SELECT id FROM runs WHERE thread_id=? AND json_extract(value,'$.state')='running'",
          )
          .get(threadId)
      )
        throw new RuntimeError(
          "conflict",
          "Profile has active turns or branch operations",
        );
      this.assertReconciled(threadId);
    }
    this.profileStore.delete(id, expectedRevision);
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }
  private workerAlive(pid: number): boolean {
    return (
      this.isAlive(pid) || (process.platform !== "win32" && this.isAlive(-pid))
    );
  }
  inspectRunOwnership(id: string): {
    state: "active" | "stopped" | "unknown";
    pid?: number;
  } {
    const run = this.getRun(id);
    const row = this.db
      .prepare("SELECT worker_pid FROM runs WHERE id=?")
      .get(id)!;
    const pid = row.worker_pid === null ? undefined : Number(row.worker_pid);
    const identity = pid === undefined ? {} : { pid };
    if (this.active.has(id)) return { state: "active", ...identity };
    if (
      run.reconciliation ||
      ["completed", "failed", "cancelled"].includes(run.state)
    )
      return { state: "stopped", ...identity };
    if (pid === undefined) return { state: "unknown" };
    return {
      state: this.workerAlive(pid)
        ? "active"
        : run.errorCode === "cleanup_uncertain" ||
            run.workerOwnership === "guardian"
          ? "unknown"
          : "stopped",
      pid,
    };
  }
  reconcileRun(
    id: string,
    input: { reason: string; confirmStopped?: boolean },
  ): Run {
    this.assertOpen();
    if (
      !exactObject(
        input,
        input?.confirmStopped === undefined
          ? ["reason"]
          : ["reason", "confirmStopped"],
      ) ||
      !boundedText(input.reason, 10000) ||
      (input.confirmStopped !== undefined &&
        typeof input.confirmStopped !== "boolean")
    )
      throw new RuntimeError("invalid", "Invalid reconciliation");
    return this.transaction(() => {
      const run = this.getRun(id);
      if (run.reconciliation) {
        if (run.reconciliation.reason !== input.reason)
          throw new RuntimeError(
            "conflict",
            "Run already reconciled with a different reason",
          );
        return run;
      }
      if (run.state !== "attention_required" && run.state !== "interrupted")
        throw new RuntimeError(
          "conflict",
          "Run does not require reconciliation",
        );
      const ownership = this.inspectRunOwnership(id);
      if (ownership.state === "active")
        throw new RuntimeError("conflict", "Cannot reconcile a live worker");
      if (ownership.state === "unknown" && input.confirmStopped !== true)
        throw new RuntimeError(
          "conflict",
          "Unknown worker ownership requires explicit stopped confirmation",
        );
      const at = new Date().toISOString();
      run.reconciliation = { reason: input.reason, at };
      run.state = "interrupted";
      run.endedAt = at;
      run.errorCode = "interrupted";
      this.db
        .prepare("UPDATE runs SET value=? WHERE id=?")
        .run(JSON.stringify(run), id);
      this.appendEvent(id, { type: "state", state: "interrupted" });
      return run;
    });
  }
  private assertOpen() {
    if (this.storageFailed)
      throw new RuntimeError(
        "unavailable",
        "Runtime storage requires recovery",
      );
    if (this.closed || this.closing)
      throw new RuntimeError("closed", "Runtime is closed");
  }
  private assertReconciled(threadId: string) {
    if (this.forkStore.unresolved(threadId))
      throw new RuntimeError(
        "unavailable",
        "Fork ownership needs reconciliation",
      );
    for (const previous of this.db
      .prepare(
        "SELECT id FROM runs WHERE thread_id=? AND json_extract(value,'$.state') IN ('interrupted','attention_required') AND json_extract(value,'$.reconciliation') IS NULL",
      )
      .all(threadId)) {
      if (this.inspectRunOwnership(String(previous.id)).state !== "stopped")
        throw new RuntimeError(
          "unavailable",
          "Interrupted worker ownership needs reconciliation",
        );
    }
  }
  private profileFor(id: string): AgentProfile {
    const profile = this.profiles.get(id);
    if (!profile)
      throw new RuntimeError(
        "unavailable",
        "Agent profile is no longer configured",
      );
    return profile;
  }
  createThread(input: {
    profileId: string;
    idempotencyKey?: string;
    owner?: ThreadOwner;
  }): Thread {
    this.assertOpen();
    if (
      !input ||
      typeof input !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).some(
        (key) =>
          typeof key !== "string" ||
          !["profileId", "idempotencyKey", "owner"].includes(key) ||
          !("value" in Object.getOwnPropertyDescriptor(input, key)!),
      ) ||
      !boundedText(input.profileId, 64) ||
      (input.idempotencyKey !== undefined &&
        !boundedText(input.idempotencyKey, 256))
    )
      throw new RuntimeError("invalid", "Invalid thread creation input");
    const { profileId, idempotencyKey } = input;
    const owner = input.owner ?? { kind: "operator" };
    validateOwner(owner);
    return this.transaction(() => {
      if (idempotencyKey !== undefined) {
        const previous = this.db
          .prepare(
            "SELECT profile_id,thread_id FROM thread_requests WHERE key=?",
          )
          .get(idempotencyKey);
        if (previous) {
          if (previous.profile_id !== profileId)
            throw new RuntimeError(
              "conflict",
              "Thread creation key reused for a different profile",
            );
          const thread = this.getThread(String(previous.thread_id));
          if (JSON.stringify(thread.owner) !== JSON.stringify(owner))
            throw new RuntimeError(
              "conflict",
              "Thread creation key belongs to a different owner",
            );
          return thread;
        }
      }
      if (!this.profiles.has(profileId))
        throw new RuntimeError("not_found", "Unknown agent profile");
      const thread: Thread = {
        id: randomUUID(),
        profileId,
        owner: structuredClone(owner),
        createdAt: new Date().toISOString(),
      };
      this.db
        .prepare("INSERT INTO threads(id,value) VALUES (?,?)")
        .run(thread.id, JSON.stringify(thread));
      if (idempotencyKey !== undefined)
        this.db
          .prepare(
            "INSERT INTO thread_requests(key,profile_id,thread_id) VALUES(?,?,?)",
          )
          .run(idempotencyKey, profileId, thread.id);
      return thread;
    });
  }
  branchPoints(threadId: string): Promise<BranchPoint[]> {
    this.assertOpen();
    const thread = this.getThread(threadId);
    const profile = this.profileFor(thread.profileId);
    this.assertReconciled(thread.id);
    if (!thread.sessionPath) return Promise.resolve([]);
    const discover = this.options.worker.branchPoints;
    if (!discover)
      throw new RuntimeError(
        "unavailable",
        "Worker does not support branch discovery",
      );
    if (
      this.branches.has(thread.id) ||
      this.db
        .prepare(
          "SELECT id FROM runs WHERE thread_id=? AND json_extract(value,'$.state')='running'",
        )
        .get(thread.id)
    )
      throw new RuntimeError(
        "conflict",
        "Thread already has an active turn or branch",
      );
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(async () => {
        const result = await discover.call(this.options.worker, {
          profile: structuredClone(profile),
          sessionPath: thread.sessionPath!,
          signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        return result;
      })
      .finally(() => this.branches.delete(thread.id));
    this.branches.set(thread.id, { controller, done });
    return done;
  }
  getForkOperation(id: string): ForkOperation {
    this.assertOpen();
    return this.forkStore.get(id);
  }
  findForkByRequest(key: string): ForkOperation | undefined {
    this.assertOpen();
    if (!boundedText(key, 256))
      throw new RuntimeError("invalid", "Invalid fork request identity");
    return this.forkStore.find(key);
  }
  listForkOperations(
    threadId: string,
    input: { after?: string; limit?: number } = {},
  ) {
    this.getThread(threadId);
    return this.forkStore.list(threadId, input);
  }
  inspectForkOwnership(id: string): {
    state: "active" | "stopped" | "unknown";
    pid?: number;
  } {
    const op = this.getForkOperation(id);
    const pid = this.forkStore.pid(id);
    const identity = pid === undefined ? {} : { pid };
    if (this.branches.has(op.parentThreadId) && op.state === "running")
      return { state: "active", ...identity };
    if (op.state === "completed" || op.state === "cancelled")
      return { state: "stopped", ...identity };
    return pid === undefined
      ? { state: "unknown" }
      : {
          state: this.workerAlive(pid)
            ? "active"
            : op.cleanupUnconfirmed || op.workerOwnership === "guardian"
              ? "unknown"
              : "stopped",
          pid,
        };
  }
  reconcileFork(
    id: string,
    input: { reason: string; confirmStopped?: boolean },
  ): ForkOperation {
    this.assertOpen();
    if (
      !exactObject(
        input,
        input?.confirmStopped === undefined
          ? ["reason"]
          : ["reason", "confirmStopped"],
      ) ||
      !boundedText(input.reason, 10000) ||
      (input.confirmStopped !== undefined &&
        typeof input.confirmStopped !== "boolean")
    )
      throw new RuntimeError("invalid", "Invalid reconciliation");
    return this.transaction(() => {
      const op = this.forkStore.get(id);
      if (op.reconciliation) {
        if (op.reconciliation.reason !== input.reason)
          throw new RuntimeError(
            "conflict",
            "Fork already reconciled with a different reason",
          );
        return op;
      }
      if (op.state !== "attention_required")
        throw new RuntimeError(
          "conflict",
          "Fork does not require reconciliation",
        );
      const ownership = this.inspectForkOwnership(id);
      if (ownership.state === "active")
        throw new RuntimeError("conflict", "Cannot reconcile a live worker");
      if (ownership.state === "unknown" && input.confirmStopped !== true)
        throw new RuntimeError(
          "conflict",
          "Unknown worker ownership requires explicit stopped confirmation",
        );
      const at = new Date().toISOString();
      op.state = "cancelled";
      op.endedAt = at;
      op.reconciliation = { reason: input.reason, at };
      this.forkStore.save(op);
      return op;
    });
  }
  forkThread(input: {
    threadId: string;
    entryId: string;
    idempotencyKey?: string;
    replyToRunId?: string;
    replyToRole?: "user" | "assistant";
  }): Promise<Thread> {
    this.assertOpen();
    if (
      !exactObject(input, [
        "threadId",
        "entryId",
        ...(input?.idempotencyKey === undefined ? [] : ["idempotencyKey"]),
        ...(input?.replyToRunId === undefined ? [] : ["replyToRunId"]),
        ...(input?.replyToRole === undefined ? [] : ["replyToRole"]),
      ]) ||
      !boundedText(input.threadId, 256) ||
      !boundedText(input.entryId, 1024) ||
      (input.replyToRole !== undefined &&
        (input.replyToRunId === undefined ||
          !["user", "assistant"].includes(input.replyToRole))) ||
      (input.replyToRunId !== undefined &&
        !boundedText(input.replyToRunId, 256)) ||
      (input.idempotencyKey !== undefined &&
        !boundedText(input.idempotencyKey, 256))
    )
      throw new RuntimeError("invalid", "Invalid fork input");
    if (input.idempotencyKey !== undefined) {
      const previous = this.forkStore.find(input.idempotencyKey);
      if (previous) {
        if (
          previous.parentThreadId !== input.threadId ||
          previous.entryId !== input.entryId ||
          previous.replyToRunId !== input.replyToRunId ||
          (previous.replyToRole ?? "assistant") !==
            (input.replyToRole ?? "assistant")
        )
          throw new RuntimeError(
            "conflict",
            "Fork key reused with different input",
          );
        if (previous.state === "completed")
          return Promise.resolve(this.getThread(previous.childThreadId));
        throw new RuntimeError(
          previous.state === "running" ? "conflict" : "unavailable",
          previous.state === "cancelled"
            ? "Fork request was abandoned"
            : "Fork requires reconciliation or completion",
        );
      }
    }
    const parent = this.getThread(input.threadId);
    let replyContext: ReplyContext | undefined;
    if (input.replyToRunId !== undefined) {
      const run = this.getRun(input.replyToRunId);
      if (
        run.threadId !== parent.id ||
        run.state !== "completed" ||
        run.userEntryId !== input.entryId
      )
        throw new RuntimeError(
          "invalid",
          "Reply requires an exact completed parent run and entry.",
        );
      const chunks: string[] = [];
      let after = 0;
      for (;;) {
        const page = this.events(run.id, after);
        for (const event of page)
          if (event.type === "text") chunks.push(event.text);
        if (page.length < 1000) break;
        after = page[page.length - 1]!.sequence;
      }
      const assistantText = chunks.join("");
      if (input.replyToRole !== "user" && !assistantText.trim())
        throw new RuntimeError(
          "invalid",
          "Selected run has no assistant text to reply to.",
        );
      let contextPrompt: string | undefined;
      if (parent.replyContext) {
        const source = this.db
          .prepare("SELECT input FROM runs WHERE id=?")
          .get(run.id);
        const submitted = source && JSON.parse(String(source.input));
        if (!submitted || typeof submitted.workerText !== "string")
          throw new RuntimeError(
            "unavailable",
            "The selected reply run has no recorded contextual prompt.",
          );
        contextPrompt = submitted.workerText;
      }
      replyContext = {
        ...(run.attachments?.length
          ? { attachments: structuredClone(run.attachments) }
          : {}),
        ...(input.replyToRole === "user" ? { role: "user" as const } : {}),
        ...(run.workerAttachmentSources?.length
          ? {
              workerAttachmentSources: structuredClone(
                run.workerAttachmentSources,
              ),
              workerAttachmentMetadata: structuredClone(
                run.workerAttachmentMetadata,
              ),
            }
          : {}),
        version: 1,
        parentThreadId: parent.id,
        runId: run.id,
        entryId: input.entryId,
        prompt: run.text,
        ...(contextPrompt === undefined ? {} : { contextPrompt }),
        ...(input.replyToRole === "user" ? {} : { assistantText }),
        createdAt: run.createdAt,
        ...(input.replyToRole !== "user" && run.endedAt
          ? { endedAt: run.endedAt }
          : {}),
      };
      replyPrompt(replyContext, "");
    }
    const profile = this.profileFor(parent.profileId);
    this.assertReconciled(parent.id);
    if (!parent.sessionPath)
      throw new RuntimeError("conflict", "Thread has no checkpoint to fork");
    if (
      this.branches.has(parent.id) ||
      this.db
        .prepare(
          "SELECT id FROM runs WHERE thread_id=? AND json_extract(value,'$.state')='running'",
        )
        .get(parent.id)
    )
      throw new RuntimeError(
        "conflict",
        "Thread already has an active turn or branch",
      );
    const op: ForkOperation = {
      ...(input.replyToRole === "user" ? { replyToRole: "user" as const } : {}),
      ...(replyContext
        ? { replyToRunId: input.replyToRunId, replyContext }
        : {}),
      id: randomUUID(),
      parentThreadId: parent.id,
      childThreadId: randomUUID(),
      entryId: input.entryId,
      state: "running",
      createdAt: new Date().toISOString(),
    };
    try {
      this.forkStore.insert(op, input.idempotencyKey);
    } catch (error) {
      this.failStorage();
      throw error;
    }
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(async () => {
        try {
          controller.signal.throwIfAborted();
          const result = await this.options.worker.fork({
            threadId: op.childThreadId,
            profile: structuredClone(profile),
            sessionPath: parent.sessionPath!,
            entryId: op.entryId,
            signal: controller.signal,
            onProcess: (pid, ownership) => {
              controller.signal.throwIfAborted();
              this.assertOpen();
              if (
                !this.branches.has(parent.id) ||
                this.forkStore.get(op.id).state !== "running"
              )
                throw new RuntimeError("conflict", "Fork is no longer active");
              if (
                !Number.isSafeInteger(pid) ||
                pid <= 0 ||
                (ownership !== undefined && ownership !== "guardian")
              )
                throw new RuntimeError(
                  "invalid",
                  "Invalid fork process identity",
                );
              try {
                this.transaction(() => {
                  this.forkStore.process(op.id, pid);
                  if (ownership === "guardian") {
                    op.workerOwnership = ownership;
                    this.forkStore.save(op);
                  }
                });
              } catch (error) {
                this.failStorage();
                throw error;
              }
            },
          });
          controller.signal.throwIfAborted();
          if (!boundedText(result.sessionPath, 32768))
            throw new RuntimeError("invalid", "Invalid fork checkpoint");
          const child: Thread = {
            ...(op.replyContext
              ? { replyContext: structuredClone(op.replyContext) }
              : {}),
            id: op.childThreadId,
            profileId: parent.profileId,
            owner: structuredClone(
              this.getThread(parent.id).owner ?? { kind: "unresolved" },
            ),
            parentId: parent.id,
            branchEntryId: op.entryId,
            sessionPath: result.sessionPath,
            createdAt: op.createdAt,
          };
          try {
            this.transaction(() => {
              this.db
                .prepare("INSERT INTO threads(id,value) VALUES (?,?)")
                .run(child.id, JSON.stringify(child));
              this.forkStore.save({
                ...op,
                state: "completed",
                endedAt: new Date().toISOString(),
              });
            });
          } catch (error) {
            this.failStorage();
            throw error;
          }
          return child;
        } catch (error) {
          if (!this.storageFailed) {
            try {
              this.forkStore.save({
                ...op,
                state: "attention_required",
                ...(error instanceof RuntimeError &&
                error.code === "cleanup_uncertain"
                  ? { cleanupUnconfirmed: true as const }
                  : {}),
              });
            } catch {
              this.failStorage();
            }
          }
          throw error instanceof RuntimeError
            ? error
            : new RuntimeError(
                "unavailable",
                "Native fork did not complete; ownership requires reconciliation",
              );
        }
      })
      .finally(() => this.branches.delete(parent.id));
    this.branches.set(parent.id, { controller, done });
    return done;
  }
  /** Startup-only authoritative cross-store ownership recovery, before HTTP admission. */
  reconcileThreadOwners(
    bindings: Array<{
      threadId?: string;
      idempotencyKey?: string;
      owner: ThreadOwner;
    }>,
  ): void {
    this.assertOpen();
    this.transaction(() => {
      const threads = new Map(
        this.db
          .prepare("SELECT value FROM threads")
          .all()
          .map((row) => {
            const thread = JSON.parse(String(row.value)) as Thread;
            return [thread.id, thread];
          }),
      );
      const assign = (id: string, owner: ThreadOwner) => {
        validateOwner(owner);
        const thread = threads.get(id);
        if (!thread)
          throw new RuntimeError(
            "unavailable",
            "Domain mapping references an unknown thread",
          );
        if (
          thread.owner &&
          thread.owner.kind !== "unresolved" &&
          thread.owner.kind !== "operator" &&
          JSON.stringify(thread.owner) !== JSON.stringify(owner)
        )
          throw new RuntimeError(
            "unavailable",
            "Conflicting thread domain ownership",
          );
        // Durable authoritative domain records outrank a historical private label.
        thread.owner = structuredClone(owner);
      };
      for (const row of this.db
        .prepare("SELECT thread_id,value FROM runs")
        .all()) {
        const run = JSON.parse(String(row.value)) as Run;
        if (run.task)
          assign(String(row.thread_id), { kind: "task", id: run.task.taskId });
      }
      for (const binding of bindings) {
        if (binding.threadId) assign(binding.threadId, binding.owner);
        if (binding.idempotencyKey) {
          const row = this.db
            .prepare("SELECT thread_id FROM thread_requests WHERE key=?")
            .get(binding.idempotencyKey);
          if (row) assign(String(row.thread_id), binding.owner);
        }
      }
      // Forks can predate their domain binding. Carry parent authority through every descendant.
      for (let pass = 0; pass < threads.size; pass++) {
        let changed = false;
        for (const thread of threads.values()) {
          const parent = thread.parentId && threads.get(thread.parentId);
          if (
            parent &&
            (parent.owner?.kind === "task" ||
              parent.owner?.kind === "channel") &&
            JSON.stringify(thread.owner) !== JSON.stringify(parent.owner)
          ) {
            assign(thread.id, parent.owner);
            changed = true;
          }
        }
        if (!changed) break;
      }
      for (const thread of threads.values()) {
        if (!thread.owner) {
          const key = this.db
            .prepare("SELECT key FROM thread_requests WHERE thread_id=?")
            .get(thread.id)?.key;
          const runs = this.db
            .prepare("SELECT request_key FROM runs WHERE thread_id=?")
            .all(thread.id);
          const knownOperator =
            typeof key === "string" &&
            !key.startsWith("messaging:") &&
            runs.length > 0 &&
            runs.every(
              (row) => !String(row.request_key).startsWith("message:"),
            );
          thread.owner = { kind: knownOperator ? "operator" : "unresolved" };
        }
        this.db
          .prepare("UPDATE threads SET value=? WHERE id=?")
          .run(JSON.stringify(thread), thread.id);
      }
    });
  }
  threadOwnershipRevision(id: string): string {
    return createHash("sha256")
      .update(JSON.stringify(this.getThread(id)))
      .digest("hex");
  }
  private hasDomainReservation(id: string): boolean {
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current && !seen.has(current)) {
      seen.add(current);
      const thread = this.getThread(current);
      if (
        thread.owner?.kind === "task" ||
        thread.owner?.kind === "channel" ||
        thread.owner?.kind === "voice"
      )
        return true;
      const key = this.db
        .prepare("SELECT key FROM thread_requests WHERE thread_id=?")
        .get(current)?.key;
      if (
        typeof key === "string" &&
        /^(messaging:|channel-fork:|voice:)/.test(key)
      )
        return true;
      if (
        this.db
          .prepare(
            "SELECT id FROM runs WHERE thread_id=? AND (request_key LIKE 'message:%' OR json_extract(value,'$.task') IS NOT NULL)",
          )
          .get(current)
      )
        return true;
      current = thread.parentId;
    }
    return false;
  }
  claimOperatorThread(
    id: string,
    input: {
      expectedRevision: string;
      confirmStopped: boolean;
      reason: string;
    },
  ): Thread {
    this.assertOpen();
    if (
      !exactObject(input, ["expectedRevision", "confirmStopped", "reason"]) ||
      input.confirmStopped !== true ||
      !boundedText(input.reason, 2000)
    )
      throw new RuntimeError(
        "invalid",
        "Explicit stopped confirmation and reason required",
      );
    return this.transaction(() => {
      const thread = this.getThread(id);
      if (
        thread.owner?.kind !== "unresolved" ||
        this.hasDomainReservation(id) ||
        input.expectedRevision !== this.threadOwnershipRevision(id) ||
        this.branches.has(id) ||
        this.db
          .prepare(
            "SELECT id FROM runs WHERE thread_id=? AND json_extract(value,'$.state') IN ('running','attention_required')",
          )
          .get(id)
      )
        throw new RuntimeError(
          "conflict",
          "Thread ownership changed or execution is not reconciled",
        );
      thread.owner = { kind: "operator" };
      this.db
        .prepare("UPDATE threads SET value=? WHERE id=?")
        .run(JSON.stringify(thread), id);
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS thread_owner_claims(thread_id TEXT PRIMARY KEY,reason TEXT NOT NULL,at TEXT NOT NULL) STRICT",
      );
      this.db
        .prepare("INSERT INTO thread_owner_claims VALUES(?,?,?)")
        .run(id, input.reason, new Date().toISOString());
      return thread;
    });
  }
  listProfiles(): Array<
    Pick<AgentProfile, "id" | "modelIds" | "defaultModelId">
  > {
    this.assertOpen();
    return [...this.profiles.values()].map((profile) => ({
      id: profile.id,
      modelIds: [...profile.modelIds],
      defaultModelId: profile.defaultModelId,
    }));
  }
  /** Exhaustive internal read. Use pageThreads for bounded operator history. */
  listThreads(): Thread[] {
    this.assertOpen();
    return this.db
      .prepare("SELECT value FROM threads ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(String(row.value)) as Thread);
  }
  /** Exhaustive internal read, including recovery matches beyond a UI page. */
  listRuns(threadId: string): Run[] {
    this.getThread(threadId);
    return this.db
      .prepare("SELECT value FROM runs WHERE thread_id=? ORDER BY rowid")
      .all(threadId)
      .map((row) => JSON.parse(String(row.value)) as Run);
  }
  /** Read-only label: first own prompt, never an inherited branch or generated title. */
  threadPreview(threadId: string): string | undefined {
    this.getThread(threadId);
    const row = this.db
      .prepare(
        "SELECT substr(json_extract(value,'$.text'),1,512) AS preview FROM runs WHERE thread_id=? ORDER BY rowid LIMIT 1",
      )
      .get(threadId);
    if (typeof row?.preview !== "string") return;
    const preview = Array.from(row.preview.replace(/\s+/gu, " ").trim())
      .slice(0, 120)
      .join("");
    return preview || undefined;
  }
  pageThreads(input: ThreadPageInput = {}) {
    this.assertOpen();
    return this.historyPages.threads(input);
  }
  activity(input: ActivityInput = {}) {
    this.assertOpen();
    return runtimeActivity(this.db, input);
  }
  pageRuns(threadId: string, input: HistoryPageInput = {}) {
    this.getThread(threadId);
    return this.historyPages.runs(threadId, input);
  }
  /** Compatibility-only bounded array projection; new callers must use pages. */
  legacyThreadList() {
    this.assertOpen();
    return this.historyPages.legacyThreads();
  }
  legacyRunList(threadId: string) {
    this.getThread(threadId);
    return this.historyPages.legacyRuns(threadId);
  }
  /** Current work is independent of history order, page size and wall-clock skew. */
  currentRuns(threadId: string): Run[] {
    this.getThread(threadId);
    return this.db
      .prepare(
        "SELECT value FROM runs WHERE thread_id=? AND json_extract(value,'$.state') IN ('running','attention_required') ORDER BY rowid",
      )
      .all(threadId)
      .map((row) => JSON.parse(String(row.value)) as Run);
  }
  threadWork(threadId: string) {
    this.getThread(threadId);
    return threadWork(this.db, threadId);
  }
  getThread(id: string): Thread {
    this.assertOpen();
    const row = this.db.prepare("SELECT value FROM threads WHERE id=?").get(id);
    if (!row) throw new RuntimeError("not_found", "Unknown thread");
    return JSON.parse(String(row.value)) as Thread;
  }
  threadSummary(id: string) {
    this.getThread(id);
    return threadSummary(this.db, id);
  }
  startTurn(input: TurnInput): Run {
    return this.startOwnedTurn(input);
  }
  /** Trusted native conversation caller only; operator turn routes use startTurn. */
  startConversationTurn(
    input: TurnInput,
    context: ConversationOutputContext,
  ): Run {
    const conversation = conversationOutputContext(context),
      thread = this.getThread(input.threadId);
    if (
      input.task !== undefined ||
      thread.owner?.kind !== "channel" ||
      thread.owner.id !== conversation.channelId
    )
      throw new RuntimeError(
        "invalid",
        "Conversation output ownership mismatch",
      );
    return this.startOwnedTurn(input, conversation);
  }
  private startOwnedTurn(
    input: TurnInput,
    conversation?: ConversationOutputContext,
  ): Run {
    this.assertOpen();
    if (
      typeof input.text !== "string" ||
      Buffer.byteLength(input.text) > 128 * 1024
    )
      throw new RuntimeError("invalid", "Invalid turn text");
    if (
      typeof input.idempotencyKey !== "string" ||
      !input.idempotencyKey.trim() ||
      input.idempotencyKey.length > 128
    )
      throw new RuntimeError("invalid", "Invalid idempotency key");
    if (
      input.task !== undefined &&
      (!exactObject(input.task, ["taskId", "attemptId"]) ||
        !boundedText(input.task.taskId, 256) ||
        !boundedText(input.task.attemptId, 256))
    )
      throw new RuntimeError("invalid", "Invalid task context");
    const task =
      input.task === undefined
        ? undefined
        : { taskId: input.task.taskId, attemptId: input.task.attemptId };
    const ids = attachmentIds(input.attachmentIds);
    const thread = this.getThread(input.threadId);
    const currentAttachments = resolveAttachments(
      thread,
      ids,
      this.options.resolveAttachments,
    );
    if (!input.text.trim() && !currentAttachments.length)
      throw new RuntimeError(
        "invalid",
        "A turn requires text or verified attachments",
      );
    const currentMetadata = currentAttachments.map(metadata);
    const request = JSON.stringify({
      ...(ids.length
        ? { attachmentIds: ids, attachments: currentMetadata }
        : {}),
      ...(task ? { task } : {}),
      ...(conversation ? { conversation: structuredClone(conversation) } : {}),
      text: input.text,
      modelId: input.modelId ?? null,
    });
    const previous = this.db
      .prepare("SELECT id,input FROM runs WHERE thread_id=? AND request_key=?")
      .get(input.threadId, input.idempotencyKey);
    if (previous) {
      const saved = JSON.parse(String(previous.input)) as { request: string };
      if (saved.request !== request)
        throw new RuntimeError(
          "conflict",
          "Idempotency key reused with different input",
        );
      return this.getRun(String(previous.id));
    }
    const sources = attachmentSources(
      thread.replyContext?.workerAttachmentSources,
      thread.id,
      ids,
    );
    const inherited = (
      thread.replyContext?.workerAttachmentSources || []
    ).flatMap((source) =>
      resolveAttachments(
        this.getThread(source.threadId),
        source.attachmentIds,
        this.options.resolveAttachments,
      ),
    );
    sameAttachments(
      inherited.map(metadata),
      thread.replyContext?.workerAttachmentMetadata || [],
    );
    const workerMetadata = [...inherited.map(metadata), ...currentMetadata];
    assertAttachmentBudget(workerMetadata);
    const workerText = replyPrompt(thread.replyContext, input.text);
    if (this.branches.has(thread.id))
      throw new RuntimeError("conflict", "Thread is branching");
    if (
      this.db
        .prepare(
          "SELECT id FROM runs WHERE thread_id=? AND json_extract(value, '$.state')='running' LIMIT 1",
        )
        .get(thread.id)
    )
      throw new RuntimeError("conflict", "Thread already has an active turn");
    this.assertReconciled(thread.id);
    const profile = this.profileFor(thread.profileId);
    const modelId = input.modelId ?? profile.defaultModelId;
    if (!profile.modelIds.includes(modelId))
      throw new RuntimeError("invalid", "Unknown model for this profile");
    const run: Run = {
      ...(currentMetadata.length ? { attachments: currentMetadata } : {}),
      ...(sources.length
        ? {
            workerAttachmentSources: sources,
            workerAttachmentMetadata: workerMetadata,
          }
        : {}),
      ...(task ? { task } : {}),
      ...(conversation ? { conversation: structuredClone(conversation) } : {}),
      text: input.text,
      id: randomUUID(),
      threadId: thread.id,
      state: "running",
      memoryState: profile.memory ? "unverified" : "disabled",
      modelId,
      profileRevision: this.getProfile(profile.id).revision,
      createdAt: new Date().toISOString(),
    };
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO runs(id,thread_id,request_key,input,value) VALUES (?,?,?,?,?)",
        )
        .run(
          run.id,
          thread.id,
          input.idempotencyKey,
          JSON.stringify({
            request,
            text: input.text,
            modelId,
            profile,
            task,
            ...(thread.replyContext ? { workerText } : {}),
          }),
          JSON.stringify(run),
        );
      this.appendEvent(run.id, { type: "state", state: "running" });
    });
    const controller = new AbortController();
    const workerInput: WorkerInput = {
      text: workerText,
      ...(task ? { task: structuredClone(task) } : {}),
      ...(conversation ? { conversation: structuredClone(conversation) } : {}),
      runId: run.id,
      threadId: thread.id,
      profile: structuredClone(profile),
      modelId,
      signal: controller.signal,
      resolveHistoricalAttachment: (id) => {
        controller.signal.throwIfAborted();
        return this.resolveHistoricalAttachment(run.id, id);
      },
      requestInteraction: (request, signal) => {
        this.assertOpen();
        if (!this.active.has(run.id) || controller.signal.aborted)
          throw new RuntimeError("conflict", "Run is not active");
        return this.interactionStore.request(run.id, request, signal);
      },
      ...(thread.sessionPath ? { sessionPath: thread.sessionPath } : {}),
    };
    const cancelInteractions = () => {
      if (this.storageFailed) return;
      try {
        this.interactionStore.settleRun(run.id);
      } catch {
        this.failStorage();
      }
    };
    controller.signal.addEventListener("abort", cancelInteractions, {
      once: true,
    });
    let eventCount = 0;
    let outputBytes = 0;
    let taskOutcome: TaskOutcome | undefined;
    let reportedPaths: string[] | undefined;
    let outputAcquisition = false;
    let conversationPaths: string[] | undefined;
    let conversationOutputs: ConversationOutputMetadata[] | undefined;
    const conversationScope: ConversationOutputScope | undefined = conversation
      ? {
          profileId: profile.id,
          threadId: thread.id,
          runId: run.id,
          ...conversation,
        }
      : undefined;
    const outputScope: TaskOutputScope | undefined = task
      ? {
          profileId: profile.id,
          threadId: thread.id,
          runId: run.id,
          taskId: task.taskId,
          attemptId: task.attemptId,
        }
      : undefined;
    let invalidOutcome: RuntimeError | undefined;
    const done = Promise.resolve().then(async () => {
      let checkpoint: string | undefined;
      let userEntryId: string | undefined;
      try {
        controller.signal.throwIfAborted();
        if (conversationScope && this.options.conversationOutputs) {
          outputAcquisition = true;
          const directory = await this.options.conversationOutputs.prepare(
            structuredClone(conversationScope),
            controller.signal,
          );
          controller.signal.throwIfAborted();
          if (
            typeof directory !== "string" ||
            !directory.startsWith("/") ||
            !boundedText(directory, 4096)
          )
            throw new RuntimeError(
              "invalid",
              "Invalid conversation output directory",
            );
          workerInput.outputDirectory = directory;
          outputAcquisition = false;
        }
        if (outputScope && this.options.taskOutputs) {
          outputAcquisition = true;
          const directory = await this.options.taskOutputs.prepare(
            structuredClone(outputScope),
            controller.signal,
          );
          controller.signal.throwIfAborted();
          if (
            typeof directory !== "string" ||
            !directory.startsWith("/") ||
            !boundedText(directory, 4096)
          )
            throw new RuntimeError("invalid", "Invalid task output directory");
          workerInput.outputDirectory = directory;
          outputAcquisition = false;
        }
        if (sources.length) {
          const verified = sources.flatMap((source) =>
            resolveAttachments(
              this.getThread(source.threadId),
              source.attachmentIds,
              this.options.resolveAttachments,
            ),
          );
          sameAttachments(verified.map(metadata), workerMetadata);
          assertAttachmentBudget(verified);
          workerInput.attachments = verified;
        }
        const result = await this.options.worker.run(workerInput, (event) => {
          if (!this.active.has(run.id)) return;
          controller.signal.throwIfAborted();
          if (event.type === "conversation_output") {
            if (invalidOutcome) throw invalidOutcome;
            try {
              if (
                !conversationScope ||
                !this.options.conversationOutputs ||
                conversationPaths ||
                !exactObject(event, ["type", "outputPaths"]) ||
                Object.values(Object.getOwnPropertyDescriptors(event)).some(
                  (row) => !("value" in row),
                )
              )
                throw new RuntimeError(
                  "invalid",
                  "Invalid or duplicate conversation output report",
                );
              conversationPaths = conversationOutputPaths(event.outputPaths);
            } catch (error) {
              invalidOutcome =
                error instanceof RuntimeError
                  ? error
                  : new RuntimeError(
                      "invalid",
                      "Invalid conversation output report",
                    );
              throw invalidOutcome;
            }
          }
          if (event.type === "task_outcome") {
            if (invalidOutcome) throw invalidOutcome;
            if (
              !task ||
              taskOutcome ||
              Object.values(Object.getOwnPropertyDescriptors(event)).some(
                (descriptor) => !("value" in descriptor),
              ) ||
              !exactObject(
                event,
                !Object.hasOwn(event, "outputPaths")
                  ? ["type", "outcome", "summary"]
                  : ["type", "outcome", "summary", "outputPaths"],
              ) ||
              (event.outcome !== "review" && event.outcome !== "blocked") ||
              (!boundedText(event.summary, 10000) &&
                !(event.summary === "" && event.outputPaths !== undefined))
            ) {
              invalidOutcome = new RuntimeError(
                "invalid",
                "Invalid or duplicate task outcome",
              );
              throw invalidOutcome;
            }
            if (event.outputPaths !== undefined) {
              try {
                if (!this.options.taskOutputs || !outputScope)
                  throw new RuntimeError(
                    "invalid",
                    "Task output acquisition unavailable",
                  );
                reportedPaths = taskOutputPaths(event.outputPaths);
              } catch (error) {
                invalidOutcome =
                  error instanceof RuntimeError
                    ? error
                    : new RuntimeError("invalid", "Invalid task output report");
                throw invalidOutcome;
              }
            }
            taskOutcome = { outcome: event.outcome, summary: event.summary };
          }
          const bytes = Buffer.byteLength(JSON.stringify(event));
          outputBytes += bytes;
          eventCount++;
          if (
            bytes > 64 * 1024 ||
            outputBytes > 2 * 1024 * 1024 ||
            eventCount > 8192
          )
            throw new RuntimeError("invalid", "Worker output exceeded limits");
          this.workerEvent(run.id, event);
          if (event.type === "worker_started" && event.ownership === "guardian")
            run.workerOwnership = event.ownership;
        });
        controller.signal.throwIfAborted();
        if (invalidOutcome) throw invalidOutcome;
        checkpoint = result.sessionPath;
        if (
          typeof result.userEntryId === "string" &&
          result.userEntryId.length > 0 &&
          result.userEntryId.length <= 1024 &&
          !/\s/.test(result.userEntryId) &&
          !Array.from(result.userEntryId).some(
            (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
          )
        )
          userEntryId = result.userEntryId;
        if (reportedPaths && outputScope && taskOutcome) {
          outputAcquisition = true;
          const admitted = await this.options.taskOutputs!.acquire(
            structuredClone(outputScope),
            [...reportedPaths],
            controller.signal,
          );
          controller.signal.throwIfAborted();
          taskOutcome.outputs = admittedTaskOutputs(
            admitted,
            outputScope,
            reportedPaths,
          );
          outputAcquisition = false;
        }
        if (conversationPaths && conversationScope) {
          outputAcquisition = true;
          const admitted = await this.options.conversationOutputs!.acquire(
            structuredClone(conversationScope),
            [...conversationPaths],
            controller.signal,
          );
          controller.signal.throwIfAborted();
          conversationOutputs = admittedConversationOutputs(
            admitted,
            conversationScope,
            conversationPaths,
          );
          outputAcquisition = false;
        }
        run.state = "completed";
      } catch (error) {
        const cleanupUnconfirmed =
          error instanceof RuntimeError && error.code === "cleanup_uncertain";
        run.errorCode = cleanupUnconfirmed
          ? "cleanup_uncertain"
          : controller.signal.aborted
            ? "cancelled"
            : error instanceof RuntimeError
              ? error.code
              : "worker_failed";
        run.state = cleanupUnconfirmed
          ? "attention_required"
          : controller.signal.aborted
            ? "cancelled"
            : "failed";
        if (cleanupUnconfirmed)
          run.error =
            "Worker cleanup is unconfirmed; ownership requires reconciliation";
        if (run.state === "failed")
          run.error = outputAcquisition
            ? conversationScope
              ? "Conversation output acquisition failed"
              : "Task output acquisition failed"
            : "Worker did not complete";
      }
      controller.signal.removeEventListener("abort", cancelInteractions);
      if (this.storageFailed)
        throw new RuntimeError(
          "unavailable",
          "Runtime storage requires recovery",
        );
      this.interactionStore.settleRun(run.id);
      run.endedAt = new Date().toISOString();
      this.transaction(() => {
        if (
          run.state === "completed" &&
          checkpoint !== undefined &&
          userEntryId
        )
          run.userEntryId = userEntryId;
        if (run.state === "completed" && conversationOutputs)
          run.conversationOutputs = structuredClone(conversationOutputs);
        if (run.state === "completed" && taskOutcome)
          run.taskOutcome = structuredClone(taskOutcome);
        if (checkpoint !== undefined)
          this.db
            .prepare(
              "UPDATE threads SET value=json_set(value,'$.sessionPath',?) WHERE id=?",
            )
            .run(checkpoint, thread.id);
        this.db
          .prepare("UPDATE runs SET value=? WHERE id=?")
          .run(JSON.stringify(run), run.id);
        this.appendEvent(run.id, { type: "state", state: run.state });
      });
      this.active.delete(run.id);
      return structuredClone(run);
    });
    void done.catch(() => {
      controller.signal.removeEventListener("abort", cancelInteractions);
      this.failStorage();
      this.active.delete(run.id);
    });
    this.active.set(run.id, { controller, done });
    return structuredClone(run);
  }
  private failStorage(): void {
    if (this.storageFailed) return;
    this.storageFailed = true;
    this.interactionStore.failClosed();
    for (const task of this.active.values()) task.controller.abort();
    for (const branch of this.branches.values()) branch.controller.abort();
  }
  private workerEvent(runId: string, event: WorkerEvent) {
    if (event.type === "worker_started") {
      if (
        !Number.isSafeInteger(event.pid) ||
        event.pid <= 0 ||
        (event.ownership !== undefined && event.ownership !== "guardian")
      )
        throw new RuntimeError("invalid", "Invalid worker process identity");
      this.db
        .prepare(
          "UPDATE runs SET worker_pid=?, value=CASE WHEN ?='guardian' THEN json_set(value,'$.workerOwnership','guardian') ELSE value END WHERE id=?",
        )
        .run(event.pid, event.ownership ?? "", runId);
    } else if (event.type === "task_outcome")
      this.appendEvent(runId, {
        type: "task_outcome",
        outcome: event.outcome,
        summary: event.summary,
      });
    else if (event.type !== "conversation_output")
      this.appendEvent(runId, event);
  }
  private appendEvent(runId: string, event: RunEventData) {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM events WHERE run_id=?",
      )
      .get(runId)!;
    const sequence = Number(row.sequence);
    this.db
      .prepare("INSERT INTO events(run_id,sequence,value) VALUES (?,?,?)")
      .run(
        runId,
        sequence,
        JSON.stringify({ ...event, version: 1, runId, sequence }),
      );
  }
  findRunByRequest(threadId: string, idempotencyKey: string): Run | undefined {
    this.assertOpen();
    this.getThread(threadId);
    if (!boundedText(idempotencyKey, 128))
      throw new RuntimeError("invalid", "Invalid run request identity");
    const row = this.db
      .prepare("SELECT id FROM runs WHERE thread_id=? AND request_key=?")
      .get(threadId, idempotencyKey);
    return row ? this.getRun(String(row.id)) : undefined;
  }
  hasUnreconciledRuns(threadId: string): boolean {
    this.getThread(threadId);
    return (
      this.forkStore.unresolved(threadId) ||
      !!this.db
        .prepare(
          "SELECT 1 FROM runs WHERE thread_id=? AND json_extract(value,'$.state') IN ('interrupted','attention_required') AND json_extract(value,'$.reconciliation') IS NULL LIMIT 1",
        )
        .get(threadId)
    );
  }
  getRun(id: string): Run {
    this.assertOpen();
    const row = this.db.prepare("SELECT value FROM runs WHERE id=?").get(id);
    if (!row) throw new RuntimeError("not_found", "Unknown run");
    return JSON.parse(String(row.value)) as Run;
  }
  resolveHistoricalAttachment(runId: string, id: string) {
    const run = this.getRun(runId);
    const active = this.active.get(runId);
    if (run.state !== "running" || !active || active.controller.signal.aborted)
      throw new RuntimeError(
        "conflict",
        "Historical attachment access requires an active run",
      );
    return historicalAttachment(
      this.db,
      run,
      id,
      (threadId) => this.getThread(threadId),
      this.options.resolveAttachments,
    );
  }
  currentInteractions() {
    this.assertOpen();
    return this.interactionStore.currentHistory();
  }
  pageInteractionHistory(input: InteractionHistoryInput = {}) {
    this.assertOpen();
    return this.interactionStore.pageHistory(input);
  }
  listInteractions(runId: string) {
    this.getRun(runId);
    return this.interactionStore.list(runId);
  }
  respondInteraction(runId: string, id: string, response: InteractionResponse) {
    const run = this.getRun(runId);
    const active =
      run.state === "running" &&
      this.active.has(runId) &&
      !this.active.get(runId)!.controller.signal.aborted;
    return this.interactionStore.respond(runId, id, response, active);
  }
  cancelRun(id: string): Run {
    const run = this.getRun(id);
    this.active.get(id)?.controller.abort();
    return run;
  }
  async waitForRun(id: string): Promise<Run> {
    this.getRun(id);
    return structuredClone(
      await (this.active.get(id)?.done ?? this.getRun(id)),
    );
  }
  events(runId: string, after = 0): RunEvent[] {
    this.getRun(runId);
    if (!Number.isSafeInteger(after) || after < 0)
      throw new RuntimeError("invalid", "Invalid event cursor");
    return this.db
      .prepare(
        "SELECT value FROM events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT 1000",
      )
      .all(runId, after)
      .map((row) => JSON.parse(String(row.value)) as RunEvent);
  }
  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.shutdown = this.closeOwnedWork();
    return this.shutdown;
  }
  private async closeOwnedWork(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    for (const branch of this.branches.values()) branch.controller.abort();
    await Promise.allSettled(
      [...this.branches.values()].map((branch) => branch.done),
    );
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled(
      [...this.active.values()].map((task) => task.done),
    );
    try {
      this.db.prepare("DELETE FROM owner WHERE id=?").run(this.ownerId);
    } finally {
      this.closed = true;
      this.db.close();
    }
  }
}

function exactObject(value: unknown, keys: string[]): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function boundedText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    !value.includes("\0") &&
    value.length <= maximum
  );
}

function validateOwner(owner: ThreadOwner): void {
  if (
    !owner ||
    !["operator", "task", "channel", "voice", "unresolved"].includes(
      owner.kind,
    ) ||
    !exactObject(
      owner,
      owner.kind === "task" ||
        owner.kind === "channel" ||
        owner.kind === "voice"
        ? ["kind", "id"]
        : ["kind"],
    ) ||
    ((owner.kind === "task" ||
      owner.kind === "channel" ||
      owner.kind === "voice") &&
      !boundedText(owner.id, 256))
  )
    throw new RuntimeError("invalid", "Invalid thread owner");
}
