import {
  taskOutputManifest,
  type TaskOutputMetadata,
} from "@mindi/agent-runtime/task-outputs";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  TaskError,
  type Board,
  type Page,
  type PageInput,
  type Task,
  type CreateTask,
  type UpdateTask,
  type TaskComment,
  type TaskActivity,
  type Attempt,
  type TaskDiscussion,
  type DiscussionCommentInput,
  type DiscussionCommentResult,
} from "./types.js";
export * from "./types.js";

type Table =
  | "boards"
  | "tasks"
  | "comments"
  | "attempts"
  | "task_discussions"
  | "task_activity";
function invalid(message: string): never {
  throw new TaskError("invalid", message);
}
function conflict(message: string): never {
  throw new TaskError("conflict", message);
}
function str(value: unknown, field: string, max = 200, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim()) ||
    value.includes("\0")
  )
    invalid(`Invalid ${field}`);
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    invalid("Invalid expectedRevision");
  return value as number;
}
function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") invalid(`Invalid ${field}`);
  return value;
}
function dispatch(value: unknown): "auto" | "manual" {
  if (value !== "auto" && value !== "manual") invalid("Invalid dispatchMode");
  return value;
}
function object(value: unknown, fields: string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
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
function dependencies(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 100 ||
    Reflect.ownKeys(value).some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)) ||
        !("value" in Object.getOwnPropertyDescriptor(value, key)!),
    )
  )
    invalid("Invalid dependencies");
  const result: string[] = [];
  for (let i = 0; i < value.length; i++)
    result.push(str(value[i], "dependency"));
  if (new Set(result).size !== result.length) invalid("Invalid dependencies");
  return result;
}

export class TaskStore {
  private db: DatabaseSync;
  private closed = false;
  private now: () => number;
  private validateAssignee?: (id: string) => void;
  private validateMessagingChannel?: (id: string) => void;
  private validateDiscussionChannel?: (id: string) => void;
  constructor({
    databasePath,
    now = Date.now,
    validateAssignee,
    validateMessagingChannel,
    validateDiscussionChannel,
  }: {
    databasePath: string;
    now?: () => number;
    validateAssignee?: (id: string) => void;
    validateMessagingChannel?: (id: string) => void;
    validateDiscussionChannel?: (id: string) => void;
  }) {
    this.now = now;
    this.validateAssignee = validateAssignee;
    this.validateMessagingChannel = validateMessagingChannel;
    this.validateDiscussionChannel = validateDiscussionChannel;
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;",
      );
      this.atomic(() => {
        const version = this.db.prepare("PRAGMA user_version").get()!
          .user_version;
        if (version !== 0 && version !== 1 && version !== 2 && version !== 3)
          throw new TaskError("unavailable", "Unsupported task schema version");
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS boards (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
          CREATE UNIQUE INDEX IF NOT EXISTS board_messaging_identity ON boards(json_extract(data,'$.messagingChannelId')) WHERE json_extract(data,'$.messagingChannelId') IS NOT NULL;
          CREATE TABLE IF NOT EXISTS tasks (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, board_id TEXT NOT NULL REFERENCES boards(id), data TEXT NOT NULL);
          CREATE UNIQUE INDEX IF NOT EXISTS routine_task_identity ON tasks(json_extract(data,'$.routineOccurrenceId')) WHERE json_extract(data,'$.routineOccurrenceId') IS NOT NULL;
          CREATE TABLE IF NOT EXISTS comments (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS attempts (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), token TEXT NOT NULL, data TEXT NOT NULL);
          CREATE UNIQUE INDEX IF NOT EXISTS active_task_attempt ON attempts(task_id) WHERE json_extract(data,'$.state')='running';
          CREATE TABLE IF NOT EXISTS idempotency (scope TEXT NOT NULL, key TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(scope,key));
          CREATE TABLE IF NOT EXISTS task_discussions (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
            task_id TEXT UNIQUE NOT NULL REFERENCES tasks(id),
            board_id TEXT NOT NULL REFERENCES boards(id), channel_id TEXT NOT NULL, data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS discussion_members (
            discussion_id TEXT NOT NULL REFERENCES task_discussions(id),
            comment_id TEXT UNIQUE NOT NULL REFERENCES comments(id),
            PRIMARY KEY(discussion_id,comment_id));
          CREATE INDEX IF NOT EXISTS discussion_pending ON task_discussions(seq) WHERE json_extract(data,'$.publication.status')='pending';
          CREATE TABLE IF NOT EXISTS task_activity (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
            task_id TEXT NOT NULL REFERENCES tasks(id), data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS task_activity_task ON task_activity(task_id,seq);
          PRAGMA user_version=3;`);
        this.validateDiscussions();
      });
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private validateDiscussions(): void {
    try {
      if (this.db.prepare("PRAGMA foreign_key_check").get())
        throw new Error("Invalid references");
      // Stored identity is immutable even when the board is rebound or archived.
      for (const row of this.db
        .prepare("SELECT * FROM task_discussions")
        .iterate()) {
        const value = JSON.parse(row.data as string) as TaskDiscussion;
        object(value, [
          "id",
          "taskId",
          "boardId",
          "channelId",
          "title",
          "createdAt",
          "publication",
        ]);
        for (const key of [
          "id",
          "taskId",
          "boardId",
          "channelId",
          "title",
          "createdAt",
        ] as const)
          str(value[key], key, key === "title" ? 500 : 200);
        if (
          value.id !== row.id ||
          value.taskId !== row.task_id ||
          value.boardId !== row.board_id ||
          value.channelId !== row.channel_id ||
          this.getTask(value.taskId).boardId !== value.boardId ||
          !Number.isFinite(Date.parse(value.createdAt))
        )
          throw new Error("Identity mismatch");
        const publication = value.publication;
        if (publication?.status === "pending") object(publication, ["status"]);
        else if (publication?.status === "published") {
          object(publication, ["status", "messageId", "publishedAt"]);
          str(publication.messageId, "messageId");
          str(publication.publishedAt, "publishedAt");
          if (!Number.isFinite(Date.parse(publication.publishedAt)))
            throw new Error("Invalid receipt");
        } else throw new Error("Invalid publication");
        if (
          !this.db
            .prepare(
              "SELECT 1 FROM discussion_members WHERE discussion_id=? LIMIT 1",
            )
            .get(value.id)
        )
          throw new Error("Missing membership");
      }
      if (
        this.db
          .prepare(
            `SELECT 1 FROM discussion_members m
        JOIN task_discussions d ON d.id=m.discussion_id JOIN comments c ON c.id=m.comment_id
        WHERE c.task_id!=d.task_id OR json_extract(c.data,'$.taskId')!=d.task_id
          OR json_extract(c.data,'$.taskId') IS NULL OR json_extract(c.data,'$.id')!=c.id
          OR json_extract(c.data,'$.id') IS NULL LIMIT 1`,
          )
          .get()
      )
        throw new Error("Invalid membership");
      const admitted = new Set<string>();
      for (const row of this.db
        .prepare(
          "SELECT key,input,result FROM idempotency WHERE scope='discussion-comments'",
        )
        .iterate()) {
        str(row.key, "idempotencyKey");
        const { comment } = this.discussionReceipt(
          JSON.parse(row.result as string),
          JSON.parse(row.input as string),
        );
        if (admitted.has(comment.id))
          throw new Error("Duplicate admission receipt");
        admitted.add(comment.id);
      }
      for (const row of this.db
        .prepare("SELECT comment_id FROM discussion_members")
        .iterate()) {
        if (!admitted.has(row.comment_id as string))
          throw new Error("Missing admission receipt");
      }
    } catch {
      throw new TaskError(
        "unavailable",
        "Invalid persisted task discussion state",
      );
    }
  }
  private discussionReceipt(
    identity: { discussionId: string; commentId: string },
    fingerprint: string,
  ): DiscussionCommentResult {
    try {
      object(identity, ["discussionId", "commentId"]);
      const comment = this.get<TaskComment>("comments", identity.commentId);
      const discussion = this.get<TaskDiscussion>(
        "task_discussions",
        identity.discussionId,
      );
      const member = this.db
        .prepare(
          `SELECT 1 FROM discussion_members m
        JOIN comments c ON c.id=m.comment_id JOIN task_discussions d ON d.id=m.discussion_id
        WHERE m.discussion_id=? AND m.comment_id=? AND c.task_id=? AND d.task_id=? AND d.channel_id=? AND d.board_id=?`,
        )
        .get(
          discussion.id,
          comment.id,
          discussion.taskId,
          discussion.taskId,
          discussion.channelId,
          discussion.boardId,
        );
      const normalized = {
        taskId: str(comment.taskId, "taskId"),
        channelId: str(discussion.channelId, "channelId"),
        author: str(comment.author, "author"),
        body: str(comment.body, "body", 10000),
      };
      if (
        !member ||
        comment.id !== identity.commentId ||
        discussion.id !== identity.discussionId ||
        comment.taskId !== discussion.taskId ||
        this.getTask(comment.taskId).boardId !== discussion.boardId ||
        createHash("sha256")
          .update(JSON.stringify(normalized))
          .digest("hex") !== fingerprint
      )
        throw new Error("Admission receipt mismatch");
      return { comment, discussion };
    } catch {
      throw new TaskError(
        "unavailable",
        "Invalid persisted task discussion admission receipt",
      );
    }
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  private check() {
    if (this.closed) throw new TaskError("closed", "Task store is closed");
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
  private timestamp() {
    return new Date(this.now()).toISOString();
  }
  private get<T>(table: Table, id: string): T {
    this.check();
    str(id, "id");
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new TaskError("not_found", `${table} not found`);
    return JSON.parse(row.data as string) as T;
  }
  private save<T extends { id: string; revision: number }>(
    table: Table,
    value: T,
  ): T {
    const previous = table === "tasks" ? this.getTask(value.id) : undefined;
    value.revision++;
    this.db
      .prepare(`UPDATE ${table} SET data=? WHERE id=?`)
      .run(JSON.stringify(value), value.id);
    if (previous) {
      const current = this.getTask(value.id);
      if (previous.status !== current.status) {
        const activity: TaskActivity = {
          id: randomUUID(),
          taskId: current.id,
          boardId: current.boardId,
          channelId: this.getBoard(current.boardId).messagingChannelId,
          title: current.title,
          from: previous.status,
          to: current.status,
          revision: current.revision,
          createdAt: this.timestamp(),
        };
        this.db
          .prepare("INSERT INTO task_activity(id,task_id,data) VALUES(?,?,?)")
          .run(activity.id, current.id, JSON.stringify(activity));
      }
    }
    return value;
  }
  listActivity(taskId: string, input: PageInput = {}): Page<TaskActivity> {
    object(input, ["after", "limit"]);
    this.getTask(taskId);
    return this.page(
      "task_activity",
      `task-activity:${taskId}`,
      input,
      "task_id=?",
      [taskId],
    );
  }
  private expected<T extends { revision: number }>(
    value: T,
    expected: number,
  ): T {
    if (value.revision !== revision(expected)) conflict("Revision conflict");
    return value;
  }
  private idempotent<T>(
    scope: string,
    key: string,
    input: unknown,
    create: () => T,
  ): T {
    str(key, "idempotencyKey");
    const identity = JSON.stringify(input);
    const row = this.db
      .prepare("SELECT input,result FROM idempotency WHERE scope=? AND key=?")
      .get(scope, key);
    if (row) {
      if (row.input !== identity) conflict("Idempotency key conflict");
      return JSON.parse(row.result as string) as T;
    }
    const result = create();
    this.db
      .prepare(
        "INSERT INTO idempotency(scope,key,input,result) VALUES(?,?,?,?)",
      )
      .run(scope, key, identity, JSON.stringify(result));
    return result;
  }
  /** Read a committed task-tool receipt without re-executing its mutation. */
  taskActionResult(
    action: "create" | "prepare",
    key: string,
  ): Task | undefined {
    this.check();
    str(key, "idempotencyKey");
    if (action !== "create" && action !== "prepare")
      invalid("Invalid task action");
    const row = this.db
      .prepare("SELECT result FROM idempotency WHERE scope=? AND key=?")
      .get(action === "create" ? "tasks" : "task-transitions", key);
    return row ? (JSON.parse(String(row.result)) as Task) : undefined;
  }
  /** Admit at most 64 native calls per run, retaining identity across restarts. */
  admitAgentToolCall(input: {
    runId: string;
    callId: string;
    identityHash: string;
  }): boolean {
    object(input, ["runId", "callId", "identityHash"]);
    const scope = `agent-tool-calls:${str(input.runId, "runId")}`;
    const key = str(input.callId, "callId");
    const identity = str(input.identityHash, "identityHash");
    if (!/^[a-f0-9]{64}$/.test(identity)) invalid("Invalid identityHash");
    return this.atomic(() => {
      const existing = this.db
        .prepare("SELECT input FROM idempotency WHERE scope=? AND key=?")
        .get(scope, key);
      if (existing) {
        if (existing.input !== identity) conflict("Agent tool call conflict");
        return true;
      }
      const count = this.db
        .prepare("SELECT count(*) AS count FROM idempotency WHERE scope=?")
        .get(scope)!.count as number;
      if (count >= 64) return false;
      this.db
        .prepare(
          "INSERT INTO idempotency(scope,key,input,result) VALUES(?,?,?,?)",
        )
        .run(scope, key, identity, "true");
      return true;
    });
  }
  createBoard(input: {
    messagingChannelId?: string | null;
    name: string;
    description?: string;
    idempotencyKey: string;
  }): Board {
    object(input, [
      "name",
      "description",
      "idempotencyKey",
      "messagingChannelId",
    ]);
    const normalized = {
      ...(input.messagingChannelId == null
        ? {}
        : {
            messagingChannelId: str(
              input.messagingChannelId,
              "messagingChannelId",
            ),
          }),
      name: str(input.name, "name"),
      description: str(
        input.description === undefined ? "" : input.description,
        "description",
        10000,
        true,
      ),
    };
    return this.atomic(() =>
      this.idempotent("boards", input.idempotencyKey, normalized, () => {
        const messagingChannelId =
          input.messagingChannelId == null
            ? null
            : str(input.messagingChannelId, "messagingChannelId");
        this.checkMessagingLink(messagingChannelId);
        const board: Board = {
          messagingChannelId,
          id: randomUUID(),
          ...normalized,
          archived: false,
          dispatchMode: "manual",
          revision: 1,
          createdAt: this.timestamp(),
        };
        this.db
          .prepare("INSERT INTO boards(id,data) VALUES(?,?)")
          .run(board.id, JSON.stringify(board));
        return board;
      }),
    );
  }
  private checkMessagingLink(id: string | null, boardId?: string): void {
    if (id === null) return;
    this.validateMessagingChannel?.(id);
    const linked = this.db
      .prepare(
        "SELECT id FROM boards WHERE json_extract(data,'$.messagingChannelId')=?",
      )
      .get(id);
    if (linked && linked.id !== boardId)
      conflict("Messaging channel already belongs to a board");
  }
  getBoard(id: string): Board {
    const board = this.get<Board>("boards", id);
    return { ...board, messagingChannelId: board.messagingChannelId ?? null };
  }
  updateBoard(
    id: string,
    input: {
      expectedRevision: number;
      messagingChannelId?: string | null;
      name?: string;
      description?: string;
      archived?: boolean;
      dispatchMode?: "auto" | "manual";
    },
  ): Board {
    object(input, [
      "expectedRevision",
      "name",
      "description",
      "archived",
      "dispatchMode",
      "messagingChannelId",
    ]);
    return this.atomic(() => {
      const board = this.expected(this.getBoard(id), input.expectedRevision);
      if (input.messagingChannelId !== undefined) {
        const link =
          input.messagingChannelId === null
            ? null
            : str(input.messagingChannelId, "messagingChannelId");
        this.checkMessagingLink(link, id);
        board.messagingChannelId = link;
      }
      if (input.name !== undefined) board.name = str(input.name, "name");
      if (input.description !== undefined)
        board.description = str(input.description, "description", 10000, true);
      if (input.archived !== undefined)
        board.archived = bool(input.archived, "archived");
      if (input.dispatchMode !== undefined)
        board.dispatchMode = dispatch(input.dispatchMode);
      return this.save("boards", board);
    });
  }
  private page<T>(
    table: Table,
    scope: string,
    input: PageInput,
    where = "1=1",
    parameters: string[] = [],
  ): Page<T> {
    this.check();
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      invalid("Invalid page limit");
    let after = 0;
    if (input.after !== undefined) {
      str(input.after, "cursor", 1000);
      try {
        const parsed: unknown = JSON.parse(
          Buffer.from(input.after, "base64url").toString(),
        );
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 2 ||
          parsed[0] !== scope ||
          !Number.isSafeInteger(parsed[1]) ||
          parsed[1] < 1
        )
          invalid("Invalid cursor");
        after = parsed[1] as number;
      } catch {
        invalid("Invalid cursor");
      }
    }
    const rows = this.db
      .prepare(
        `SELECT seq,data FROM ${table} WHERE ${where} AND seq>? ORDER BY seq LIMIT ?`,
      )
      .all(...parameters, after, limit + 1);
    const visible = rows.slice(0, limit);
    return {
      items: visible.map((row) => JSON.parse(row.data as string) as T),
      ...(rows.length > limit
        ? {
            nextCursor: Buffer.from(
              JSON.stringify([scope, visible.at(-1)!.seq]),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  listBoards(
    input: PageInput & { includeArchived?: boolean } = {},
  ): Page<Board> {
    object(input, ["after", "limit", "includeArchived"]);
    const archived =
      input.includeArchived === undefined
        ? false
        : bool(input.includeArchived, "includeArchived");
    const result = this.page<Board>(
      "boards",
      `boards:${archived}`,
      input,
      archived ? "1=1" : "json_extract(data,'$.archived')=0",
    );
    return {
      ...result,
      items: result.items.map((board) => ({
        ...board,
        messagingChannelId: board.messagingChannelId ?? null,
      })),
    };
  }

  private writable(task: Task): Task {
    if (["running", "review", "attention_required"].includes(task.status))
      conflict("Task state forbids edits");
    return task;
  }
  private priority(value: unknown): number {
    if (
      !Number.isInteger(value) ||
      (value as number) < 0 ||
      (value as number) > 4
    )
      invalid("Invalid priority");
    return value as number;
  }
  private assignee(value: unknown): string | null {
    return value === null ? null : str(value, "assignee");
  }
  private graph(task: Task, field: "parentId" | "dependencies"): void {
    const starts =
      field === "parentId"
        ? task.parentId
          ? [task.parentId]
          : []
        : task.dependencies;
    const visited = new Set<string>();
    const pending = [...starts];
    while (pending.length) {
      const id = pending.pop()!;
      if (id === task.id) conflict("Graph cycle");
      if (visited.has(id)) continue;
      visited.add(id);
      const next = this.getTask(id);
      if (next.boardId !== task.boardId)
        conflict("Graph links must share a board");
      pending.push(
        ...(field === "parentId"
          ? next.parentId
            ? [next.parentId]
            : []
          : next.dependencies),
      );
    }
  }
  createTask(input: CreateTask): Task {
    object(input, [
      "maxRetries",
      "routineOccurrenceId",
      "boardId",
      "title",
      "body",
      "assignee",
      "priority",
      "parentId",
      "completionContract",
      "status",
      "idempotencyKey",
    ]);
    const normalized = {
      ...(input.maxRetries === undefined
        ? {}
        : { maxRetries: this.failureLimit(input.maxRetries) }),
      ...(input.routineOccurrenceId === undefined
        ? {}
        : {
            routineOccurrenceId: str(
              input.routineOccurrenceId,
              "routineOccurrenceId",
            ),
          }),
      boardId: str(input.boardId, "boardId"),
      title: str(input.title, "title"),
      body: str(
        input.body === undefined ? "" : input.body,
        "body",
        50000,
        true,
      ),
      assignee: this.assignee(input.assignee ?? null),
      priority: this.priority(
        input.priority === undefined ? 2 : input.priority,
      ),
      parentId: input.parentId == null ? null : str(input.parentId, "parentId"),
      completionContract: str(
        input.completionContract === undefined ? "" : input.completionContract,
        "completionContract",
        10000,
        true,
      ),
      status: input.status === undefined ? "todo" : input.status,
    };
    if (!["todo", "triage"].includes(normalized.status))
      invalid("Invalid initial status");
    return this.atomic(() =>
      this.idempotent("tasks", input.idempotencyKey, normalized, () => {
        if (
          normalized.routineOccurrenceId &&
          this.findRoutineTask(normalized.routineOccurrenceId)
        )
          conflict("Routine occurrence already owns a task");
        if (normalized.assignee) this.validateAssignee?.(normalized.assignee);
        if (this.getBoard(normalized.boardId).archived)
          conflict("Board is archived");
        const task: Task = {
          id: randomUUID(),
          ...normalized,
          dependencies: [],
          revision: 1,
          createdAt: this.timestamp(),
        };
        this.graph(task, "parentId");
        this.db
          .prepare("INSERT INTO tasks(id,board_id,data) VALUES(?,?,?)")
          .run(task.id, task.boardId, JSON.stringify(task));
        return task;
      }),
    );
  }
  getTask(id: string): Task {
    return this.get("tasks", id);
  }
  updateTask(id: string, input: UpdateTask): Task {
    object(input, [
      "maxRetries",
      "idempotencyKey",
      "expectedRevision",
      "title",
      "body",
      "assignee",
      "priority",
      "parentId",
      "completionContract",
      "dependencies",
    ]);
    const patch: Partial<Task> = {};
    if (input.maxRetries !== undefined)
      patch.maxRetries = this.failureLimit(input.maxRetries);
    if (input.title !== undefined) patch.title = str(input.title, "title");
    if (input.body !== undefined)
      patch.body = str(input.body, "body", 50000, true);
    if (input.assignee !== undefined)
      patch.assignee = this.assignee(input.assignee);
    if (input.priority !== undefined)
      patch.priority = this.priority(input.priority);
    if (input.parentId !== undefined)
      patch.parentId =
        input.parentId === null ? null : str(input.parentId, "parentId");
    if (input.completionContract !== undefined)
      patch.completionContract = str(
        input.completionContract,
        "completionContract",
        10000,
        true,
      );
    if (input.dependencies !== undefined)
      patch.dependencies = dependencies(input.dependencies);
    const request = {
      id: str(id, "id"),
      expectedRevision: revision(input.expectedRevision),
      ...patch,
    };
    const perform = () => {
      const task = this.writable(
        this.expected(this.getTask(id), input.expectedRevision),
      );
      if (task.status === "done")
        conflict("Reopen completed task before editing");
      if (patch.assignee) this.validateAssignee?.(patch.assignee);
      Object.assign(task, patch);
      this.graph(task, "parentId");
      this.graph(task, "dependencies");
      return this.save("tasks", task);
    };
    return this.atomic(() =>
      input.idempotencyKey === undefined
        ? perform()
        : this.idempotent("task-edits", input.idempotencyKey, request, perform),
    );
  }
  listTasks(
    boardId: string,
    input: PageInput & { includeArchived?: boolean } = {},
  ): Page<Task> {
    object(input, ["after", "limit", "includeArchived"]);
    this.getBoard(boardId);
    const archived =
      input.includeArchived === undefined
        ? false
        : bool(input.includeArchived, "includeArchived");
    return this.page(
      "tasks",
      `tasks:${boardId}:${archived}`,
      input,
      `board_id=?${archived ? "" : " AND json_extract(data,'$.status')!='archived'"}`,
      [boardId],
    );
  }
  findRoutineTask(occurrenceId: string): Task | undefined {
    this.check();
    str(occurrenceId, "routineOccurrenceId");
    const row = this.db
      .prepare(
        "SELECT data FROM tasks WHERE json_extract(data,'$.routineOccurrenceId')=?",
      )
      .get(occurrenceId);
    return row ? (JSON.parse(row.data as string) as Task) : undefined;
  }
  private comment(taskId: string, author: string, body: string): TaskComment {
    const comment: TaskComment = {
      id: randomUUID(),
      taskId,
      author,
      body,
      createdAt: this.timestamp(),
    };
    this.db
      .prepare("INSERT INTO comments(id,task_id,data) VALUES(?,?,?)")
      .run(comment.id, taskId, JSON.stringify(comment));
    return comment;
  }
  addComment(
    taskId: string,
    input: { author: string; body: string; idempotencyKey: string },
  ): TaskComment {
    object(input, ["author", "body", "idempotencyKey"]);
    const normalized = {
      taskId: str(taskId, "taskId"),
      author: str(input.author, "author"),
      body: str(input.body, "body", 10000),
    };
    return this.atomic(() => {
      this.getTask(taskId);
      return this.idempotent("comments", input.idempotencyKey, normalized, () =>
        this.comment(taskId, normalized.author, normalized.body),
      );
    });
  }
  listComments(taskId: string, input: PageInput = {}): Page<TaskComment> {
    object(input, ["after", "limit"]);
    this.getTask(taskId);
    return this.page("comments", `comments:${taskId}`, input, "task_id=?", [
      taskId,
    ]);
  }

  getTaskDiscussion(taskId: string): TaskDiscussion | undefined {
    this.getTask(taskId);
    const row = this.db
      .prepare("SELECT data FROM task_discussions WHERE task_id=?")
      .get(taskId);
    return row ? (JSON.parse(row.data as string) as TaskDiscussion) : undefined;
  }
  addDiscussionComment(
    taskId: string,
    input: DiscussionCommentInput,
  ): DiscussionCommentResult {
    object(input, ["channelId", "author", "body", "idempotencyKey"]);
    const normalized = {
      taskId: str(taskId, "taskId"),
      channelId: str(input.channelId, "channelId"),
      author: str(input.author, "author"),
      body: str(input.body, "body", 10000),
    };
    return this.atomic(() => {
      // Save only immutable references in idempotency, not another copy of the comment body.
      const identity = this.idempotent(
        "discussion-comments",
        input.idempotencyKey,
        createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
        () => {
          const task = this.getTask(taskId);
          const board = this.getBoard(task.boardId);
          if (!board.messagingChannelId)
            conflict("Board is not bound to a messaging channel");
          if (board.archived || task.status === "archived")
            conflict("Task or board is archived");
          if (board.messagingChannelId !== normalized.channelId)
            conflict("Task discussion channel binding conflict");
          const existing = this.getTaskDiscussion(taskId);
          if (
            existing &&
            (existing.boardId !== board.id ||
              existing.channelId !== normalized.channelId)
          )
            conflict("Task discussion channel binding conflict");
          const validateChannel =
            this.validateDiscussionChannel ?? this.validateMessagingChannel;
          if (!validateChannel)
            throw new TaskError(
              "unavailable",
              "Messaging channel validation unavailable",
            );
          validateChannel(normalized.channelId);
          const discussion: TaskDiscussion = existing ?? {
            id: randomUUID(),
            taskId,
            boardId: board.id,
            channelId: normalized.channelId,
            title: task.title,
            createdAt: this.timestamp(),
            publication: { status: "pending" },
          };
          if (!existing)
            this.db
              .prepare(
                "INSERT INTO task_discussions(id,task_id,board_id,channel_id,data) VALUES(?,?,?,?,?)",
              )
              .run(
                discussion.id,
                taskId,
                board.id,
                discussion.channelId,
                JSON.stringify(discussion),
              );
          const comment = this.comment(
            taskId,
            normalized.author,
            normalized.body,
          );
          this.db
            .prepare(
              "INSERT INTO discussion_members(discussion_id,comment_id) VALUES(?,?)",
            )
            .run(discussion.id, comment.id);
          return { discussionId: discussion.id, commentId: comment.id };
        },
      );
      return this.discussionReceipt(
        identity,
        createHash("sha256").update(JSON.stringify(normalized)).digest("hex"),
      );
    });
  }
  listDiscussionComments(
    taskId: string,
    input: PageInput = {},
  ): Page<TaskComment> {
    object(input, ["after", "limit"]);
    this.getTask(taskId);
    return this.page(
      "comments",
      `discussion-comments:${taskId}`,
      input,
      "task_id=? AND id IN (SELECT comment_id FROM discussion_members WHERE discussion_id IN (SELECT id FROM task_discussions WHERE task_id=?))",
      [taskId, taskId],
    );
  }
  listPendingDiscussionAnchors(input: PageInput = {}): Page<TaskDiscussion> {
    object(input, ["after", "limit"]);
    return this.page(
      "task_discussions",
      "pending-discussion-anchors",
      input,
      "json_extract(data,'$.publication.status')='pending'",
    );
  }
  acknowledgeDiscussionAnchor(
    discussionId: string,
    input: { channelId: string; messageId: string },
  ): TaskDiscussion {
    object(input, ["channelId", "messageId"]);
    const channelId = str(input.channelId, "channelId");
    const messageId = str(input.messageId, "messageId");
    return this.atomic(() => {
      const discussion = this.get<TaskDiscussion>(
        "task_discussions",
        discussionId,
      );
      if (discussion.channelId !== channelId)
        conflict("Discussion receipt channel conflict");
      if (discussion.publication.status === "published") {
        if (discussion.publication.messageId !== messageId)
          conflict("Discussion receipt identity conflict");
        return discussion;
      }
      discussion.publication = {
        status: "published",
        messageId,
        publishedAt: this.timestamp(),
      };
      this.db
        .prepare("UPDATE task_discussions SET data=? WHERE id=?")
        .run(JSON.stringify(discussion), discussionId);
      return discussion;
    });
  }

  transitionTask(
    id: string,
    input: {
      /** Trusted agent preparation; HTTP operator routes must not accept this field. */
      agentPreparation?: true;
      idempotencyKey?: string;
      author?: string;
      expectedRevision: number;
      status: "triage" | "todo" | "ready" | "blocked" | "archived";
      reason: string;
    },
  ): Task {
    object(input, [
      "expectedRevision",
      "status",
      "reason",
      "idempotencyKey",
      "author",
      "agentPreparation",
    ]);
    if (
      input.agentPreparation !== undefined &&
      (input.agentPreparation !== true || input.status !== "ready")
    )
      invalid("Invalid agent preparation");
    const reason = str(input.reason, "reason", 10000);
    const author =
      input.author === undefined ? "operator" : str(input.author, "author");
    if (
      !["triage", "todo", "ready", "blocked", "archived"].includes(input.status)
    )
      invalid("Invalid operator status");
    const request = {
      id: str(id, "id"),
      expectedRevision: revision(input.expectedRevision),
      status: input.status,
      reason,
      author,
      ...(input.agentPreparation ? { agentPreparation: true } : {}),
    };
    const perform = () => {
      const task = this.writable(
        this.expected(this.getTask(id), input.expectedRevision),
      );
      if (input.agentPreparation && ["done", "archived"].includes(task.status))
        conflict("Only an operator can reopen closed work");
      task.status = input.status;
      this.comment(id, author, reason);
      return this.save("tasks", task);
    };
    return this.atomic(() =>
      input.idempotencyKey === undefined
        ? perform()
        : this.idempotent(
            "task-transitions",
            input.idempotencyKey,
            request,
            perform,
          ),
    );
  }
  reviewTask(
    id: string,
    input: {
      expectedRevision: number;
      decision: "accept" | "changes";
      reason: string;
    },
  ): Task {
    object(input, ["expectedRevision", "decision", "reason"]);
    const reason = str(input.reason, "reason", 10000);
    if (input.decision !== "accept" && input.decision !== "changes")
      invalid("Invalid review decision");
    return this.atomic(() => {
      const task = this.expected(this.getTask(id), input.expectedRevision);
      if (task.status !== "review") conflict("Task state is not review");
      const row = this.db
        .prepare(
          "SELECT data FROM attempts WHERE task_id=? ORDER BY seq DESC LIMIT 1",
        )
        .get(id);
      const attempt = row
        ? (JSON.parse(row.data as string) as Attempt)
        : undefined;
      if (attempt && (attempt.state !== "review" || attempt.review))
        conflict("Latest attempt is not awaiting review");
      task.status = input.decision === "accept" ? "done" : "todo";
      this.comment(id, "operator", reason);
      const saved = this.save("tasks", task);
      if (attempt) {
        attempt.review = {
          attemptId: attempt.id,
          decision: input.decision,
          reason,
          recordedAt: this.timestamp(),
          taskRevision: saved.revision,
        };
        this.saveAttempt(attempt);
      }
      return saved;
    });
  }
  private lease(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 86400000)
      invalid("Invalid leaseMs");
    return value;
  }
  claim(
    taskId: string,
    input: {
      expectedRevision: number;
      leaseMs: number;
      automatic?: boolean;
      purpose?: "decompose";
      idempotencyKey?: string;
    },
    admit?: (task: Task) => void,
  ): { attempt: Attempt; token: string } {
    object(input, [
      "expectedRevision",
      "leaseMs",
      "automatic",
      "purpose",
      "idempotencyKey",
    ]);
    if (input.purpose !== undefined && input.purpose !== "decompose")
      invalid("Invalid attempt purpose");
    this.lease(input.leaseMs);
    const automatic =
      input.automatic === undefined
        ? false
        : bool(input.automatic, "automatic");
    return this.atomic(() => {
      const perform = () => {
        const task = this.expected(
          this.getTask(taskId),
          input.expectedRevision,
        );
        if (
          task.status !== (input.purpose === "decompose" ? "triage" : "ready")
        )
          conflict("Task state is not eligible for this attempt purpose");
        if (!task.assignee) conflict("Task must be assigned");
        const board = this.getBoard(task.boardId);
        if (board.archived) conflict("Board is archived");
        if (automatic && board.dispatchMode !== "auto")
          conflict("Board dispatch is manual");
        if (task.dependencies.some((id) => this.getTask(id).status !== "done"))
          conflict("Dependencies are incomplete");
        admit?.(structuredClone(task));
        const previous = this.latestAttempt(taskId);
        const retryOf =
          previous?.retry?.taskRevision === task.revision &&
          previous.retry.phase === task.status &&
          previous.protocolBudget?.disposition === "below_limit" &&
          previous.state === "blocked" &&
          previous.purpose === input.purpose &&
          previous.snapshot.assignee === task.assignee
            ? previous.id
            : undefined;
        const attempt: Attempt = {
          id: randomUUID(),
          taskId,
          ...(retryOf ? { retryOf } : {}),
          state: "running",
          ...(input.purpose ? { purpose: input.purpose } : {}),
          snapshot: structuredClone(task),
          createdAt: this.timestamp(),
          leaseExpiresAt: this.now() + input.leaseMs,
        };
        const token = randomUUID() + randomUUID();
        this.db
          .prepare(
            "INSERT INTO attempts(id,task_id,token,data) VALUES(?,?,?,?)",
          )
          .run(attempt.id, taskId, token, JSON.stringify(attempt));
        task.status = "running";
        this.save("tasks", task);
        return { attempt, token };
      };
      return input.idempotencyKey === undefined
        ? perform()
        : this.idempotent(
            "dispatch",
            input.idempotencyKey,
            {
              taskId,
              expectedRevision: input.expectedRevision,
              automatic,
              ...(input.purpose ? { purpose: input.purpose } : {}),
            },
            perform,
          );
    });
  }
  getAttempt(id: string): Attempt {
    return this.get("attempts", id);
  }
  listUnsettledAttempts(input: PageInput = {}): Page<Attempt> {
    object(input, ["after", "limit"]);
    return this.page(
      "attempts",
      "unsettled-attempts",
      input,
      "json_extract(data,'$.state') IN ('running','attention_required')",
    );
  }
  bindThread(id: string, token: string, threadId: string): Attempt {
    str(threadId, "threadId");
    return this.atomic(() => {
      const attempt = this.fenced(id, token);
      if (attempt.threadId && attempt.threadId !== threadId)
        conflict("Attempt thread already bound");
      attempt.threadId = threadId;
      return this.saveAttempt(attempt);
    });
  }
  bindRun(id: string, token: string, runId: string): Attempt {
    str(runId, "runId");
    return this.atomic(() => {
      const attempt = this.fenced(id, token);
      if (!attempt.threadId || (attempt.runId && attempt.runId !== runId))
        conflict("Invalid attempt run binding");
      attempt.runId = runId;
      return this.saveAttempt(attempt);
    });
  }
  requestCancel(id: string): Attempt {
    return this.atomic(() => {
      const attempt = this.getAttempt(id);
      if (!["running", "attention_required"].includes(attempt.state))
        return attempt;
      attempt.cancellationRequestedAt ??= this.timestamp();
      return this.saveAttempt(attempt);
    });
  }
  markAttention(id: string, reason: string): Attempt {
    str(reason, "reason", 10000);
    return this.atomic(() => {
      const attempt = this.getAttempt(id);
      if (attempt.state !== "running") return attempt;
      attempt.state = "attention_required";
      attempt.summary = reason;
      const task = this.getTask(attempt.taskId);
      task.status = "attention_required";
      this.save("tasks", task);
      return this.saveAttempt(attempt);
    });
  }
  /** Trusted coordinator only: the caller must observe terminal native execution. */
  settleObserved(
    id: string,
    input: {
      outcome: "review" | "blocked";
      summary: string;
      outputs?: TaskOutputMetadata[];
      termination?: Attempt["termination"];
      missingTaskResult?: true;
    },
  ): Attempt {
    object(input, [
      "outcome",
      "summary",
      "outputs",
      "termination",
      "missingTaskResult",
    ]);
    if (
      input.missingTaskResult !== undefined &&
      input.missingTaskResult !== true
    )
      invalid("Invalid missing task result observation");
    str(
      input.summary,
      "summary",
      10000,
      input.outputs !== undefined && input.summary === "",
    );
    if (input.outcome !== "review" && input.outcome !== "blocked")
      invalid("Invalid observed outcome");
    return this.atomic(() => {
      const attempt = this.getAttempt(id);
      let termination: Attempt["termination"];
      if (input.termination !== undefined) {
        const t = input.termination;
        object(t, ["runId", "threadId", "state", "errorCode"]);
        if (
          !attempt.runId ||
          !attempt.threadId ||
          t.runId !== attempt.runId ||
          t.threadId !== attempt.threadId ||
          !["completed", "failed", "cancelled"].includes(t.state) ||
          (t.errorCode !== undefined &&
            (typeof t.errorCode !== "string" ||
              !/^[a-z][a-z0-9_]{0,79}$/.test(t.errorCode))) ||
          (input.outcome === "review" && t.state !== "completed")
        )
          invalid("Invalid observed termination");
        termination = {
          runId: t.runId,
          threadId: t.threadId,
          state: t.state,
          ...(t.errorCode !== undefined ? { errorCode: t.errorCode } : {}),
        };
      }
      let outputs: TaskOutputMetadata[] | undefined;
      if (
        input.missingTaskResult &&
        (input.outcome !== "blocked" ||
          termination?.state !== "completed" ||
          attempt.cancellationRequestedAt ||
          input.outputs !== undefined)
      )
        invalid("Missing task result requires uncancelled completed execution");
      if (input.outputs !== undefined) {
        if (!attempt.runId || !attempt.threadId || !attempt.snapshot.assignee)
          invalid("Output manifest requires native attempt ownership");
        try {
          outputs = taskOutputManifest(input.outputs, {
            profileId: attempt.snapshot.assignee,
            threadId: attempt.threadId,
            runId: attempt.runId,
            taskId: attempt.taskId,
            attemptId: attempt.id,
          });
        } catch {
          invalid("Invalid observed output manifest");
        }
      }
      if (
        attempt.state === input.outcome &&
        attempt.summary === input.summary &&
        JSON.stringify(attempt.outputs ?? null) ===
          JSON.stringify(outputs ?? null) &&
        JSON.stringify(attempt.termination ?? null) ===
          JSON.stringify(termination ?? null) &&
        (attempt.protocolBudget !== undefined) ===
          (input.missingTaskResult === true)
      )
        return attempt;
      if (!["running", "attention_required"].includes(attempt.state))
        conflict("Attempt already resolved");
      const task = this.getTask(attempt.taskId);
      if (!["running", "attention_required"].includes(task.status))
        conflict("Task is not owned by attempt");
      if (input.missingTaskResult) {
        const row = this.db
          .prepare(
            "SELECT data FROM attempts WHERE task_id=? AND seq < (SELECT seq FROM attempts WHERE id=?) AND json_extract(data,'$.endedAt') IS NOT NULL ORDER BY seq DESC LIMIT 1",
          )
          .get(attempt.taskId, attempt.id);
        const prior = row
          ? (JSON.parse(String(row.data)) as Attempt)
          : undefined;
        const budget = prior?.protocolBudget;
        if (prior && Object.hasOwn(prior, "protocolBudget")) {
          object(budget, [
            "attemptId",
            "policyVersion",
            "reason",
            "count",
            "limit",
            "limitSource",
            "disposition",
          ]);
        }
        if (
          budget &&
          (budget.attemptId !== prior!.id ||
            budget.policyVersion !== 1 ||
            budget.reason !== "missing_task_result" ||
            !Number.isSafeInteger(budget.limit) ||
            budget.limit < 1 ||
            !["builtin", "task"].includes(budget.limitSource) ||
            (budget.limitSource === "builtin"
              ? budget.limit !== 3 || prior!.snapshot.maxRetries != null
              : budget.limit !== prior!.snapshot.maxRetries) ||
            !Number.isSafeInteger(budget.count) ||
            budget.count < 1 ||
            budget.count >= Number.MAX_SAFE_INTEGER ||
            prior!.state !== "blocked" ||
            prior!.termination?.state !== "completed" ||
            prior!.termination.runId !== prior!.runId ||
            prior!.termination.threadId !== prior!.threadId ||
            prior!.cancellationRequestedAt ||
            budget.disposition !==
              (budget.count < budget.limit ? "below_limit" : "exhausted"))
        )
          invalid("Prior protocol budget evidence is invalid");
        const count = budget ? budget.count + 1 : 1;
        const override = this.failureLimit(attempt.snapshot.maxRetries ?? null);
        const limit = override ?? 3;
        attempt.protocolBudget = {
          attemptId: attempt.id,
          policyVersion: 1,
          reason: "missing_task_result",
          count,
          limit,
          limitSource: override === null ? "builtin" : "task",
          disposition: count < limit ? "below_limit" : "exhausted",
        };
      }
      attempt.state = input.outcome;
      attempt.summary = input.summary;
      if (outputs) attempt.outputs = outputs;
      if (termination) attempt.termination = termination;
      attempt.endedAt = this.timestamp();
      task.status =
        attempt.protocolBudget?.disposition === "below_limit"
          ? attempt.purpose === "decompose"
            ? "triage"
            : "ready"
          : attempt.purpose === "decompose" && input.outcome === "review"
            ? "todo"
            : input.outcome;
      this.save("tasks", task);
      if (attempt.protocolBudget?.disposition === "below_limit") {
        attempt.retry = {
          phase: attempt.purpose === "decompose" ? "triage" : "ready",
          taskRevision: task.revision,
        };
      }
      return this.saveAttempt(attempt);
    });
  }
  private fenced(attemptId: string, token: string): Attempt {
    str(token, "token", 200);
    const attempt = this.get<Attempt>("attempts", attemptId);
    const row = this.db
      .prepare("SELECT token FROM attempts WHERE id=?")
      .get(attemptId)!;
    if (
      row.token !== token ||
      attempt.state !== "running" ||
      attempt.leaseExpiresAt <= this.now() ||
      this.getTask(attempt.taskId).status !== "running"
    )
      conflict("Claim token, state or lease conflict");
    return attempt;
  }
  private saveAttempt(attempt: Attempt): Attempt {
    this.db
      .prepare("UPDATE attempts SET data=? WHERE id=?")
      .run(JSON.stringify(attempt), attempt.id);
    return attempt;
  }
  heartbeat(attemptId: string, token: string, leaseMs: number): Attempt {
    this.lease(leaseMs);
    return this.atomic(() => {
      const attempt = this.fenced(attemptId, token);
      attempt.leaseExpiresAt = this.now() + leaseMs;
      return this.saveAttempt(attempt);
    });
  }
  finish(
    attemptId: string,
    token: string,
    input: { outcome: "review" | "blocked"; summary: string },
  ): Attempt {
    object(input, ["outcome", "summary"]);
    const summary = str(input.summary, "summary", 10000);
    if (input.outcome !== "review" && input.outcome !== "blocked")
      invalid("Invalid worker outcome");
    return this.atomic(() => {
      const attempt = this.fenced(attemptId, token);
      attempt.state = input.outcome;
      attempt.summary = summary;
      attempt.endedAt = this.timestamp();
      const task = this.getTask(attempt.taskId);
      task.status =
        attempt.purpose === "decompose" && input.outcome === "review"
          ? "todo"
          : input.outcome;
      this.save("tasks", task);
      return this.saveAttempt(attempt);
    });
  }
  listAttempts(taskId: string, input: PageInput = {}): Page<Attempt> {
    object(input, ["after", "limit"]);
    this.getTask(taskId);
    return this.page("attempts", `attempts:${taskId}`, input, "task_id=?", [
      taskId,
    ]);
  }
  latestAttempt(taskId: string): Attempt | undefined {
    this.getTask(taskId);
    const row = this.db
      .prepare(
        "SELECT data FROM attempts WHERE task_id=? ORDER BY seq DESC LIMIT 1",
      )
      .get(taskId);
    return row ? (JSON.parse(String(row.data)) as Attempt) : undefined;
  }
  private failureLimit(value: unknown): number | null {
    if (value === null) return null;
    if (!Number.isSafeInteger(value) || (value as number) < 1)
      invalid("maxRetries must be a positive safe integer or null");
    return value as number;
  }

  expireClaims(): number {
    return this.atomic(() => {
      const rows = this.db
        .prepare(
          "SELECT data FROM attempts WHERE json_extract(data,'$.state')='running' AND json_extract(data,'$.leaseExpiresAt')<=?",
        )
        .all(this.now());
      for (const row of rows) {
        const attempt = JSON.parse(row.data as string) as Attempt;
        attempt.state = "attention_required";
        attempt.endedAt = this.timestamp();
        const task = this.getTask(attempt.taskId);
        task.status = "attention_required";
        this.saveAttempt(attempt);
        this.save("tasks", task);
      }
      return rows.length;
    });
  }
  reconcile(
    taskId: string,
    input: { expectedRevision: number; reason: string },
  ): Task {
    object(input, ["expectedRevision", "reason"]);
    const reason = str(input.reason, "reason", 10000);
    return this.atomic(() => {
      const task = this.expected(this.getTask(taskId), input.expectedRevision);
      if (task.status !== "attention_required")
        conflict("Task state does not require reconciliation");
      const rows = this.db
        .prepare(
          "SELECT data FROM attempts WHERE task_id=? AND json_extract(data,'$.state')='attention_required'",
        )
        .all(taskId);
      for (const row of rows) {
        const attempt = JSON.parse(row.data as string) as Attempt;
        attempt.state = "reconciled";
        this.saveAttempt(attempt);
      }
      task.status = "todo";
      this.comment(taskId, "operator", reason);
      return this.save("tasks", task);
    });
  }
}
