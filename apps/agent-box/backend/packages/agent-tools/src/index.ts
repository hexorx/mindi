import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import {
  TaskError,
  type TaskStore,
  type CreateTask,
  type UpdateTask,
  type PageInput,
} from "@mindi/tasks";
import { RuntimeError } from "@mindi/agent-runtime";
import {
  MessagingError,
  type MessagingStore,
  type PostAgentMessage,
} from "@mindi/messaging";

export const AGENT_TASK_TOOLS = [
  "kanban_boards",
  "kanban_list",
  "kanban_get",
  "kanban_create",
  "kanban_update",
  "kanban_prepare",
  "kanban_comment",
] as const;
export const AGENT_MESSAGE_TOOLS = [
  "dm_open",
  "dm_send",
  "dm_list",
  "channel_post",
] as const;
export const AGENT_TOOLS = [
  ...AGENT_TASK_TOOLS,
  ...AGENT_MESSAGE_TOOLS,
] as const;
type Tool = (typeof AGENT_TOOLS)[number];
export interface AgentToolLease {
  url: string;
  token: string;
  tools: string[];
  close(): void;
}
export interface AgentToolServer {
  open(input: {
    runId: string;
    profileId: string;
    tools: readonly string[];
    signal: AbortSignal;
  }): AgentToolLease;
  close(): Promise<void>;
}
class RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
function fail(status: number, code: string): never {
  throw new RequestError(status, code);
}
function string(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 200 ||
    value.includes("\0")
  )
    fail(400, "invalid");
  return value;
}
function object(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    fail(400, "invalid");
  return value as Record<string, unknown>;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const data = Buffer.from(chunk);
    length += data.length;
    if (length > 128 * 1024) fail(413, "too_large");
    chunks.push(data);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return fail(400, "invalid");
  }
}
const fields: Record<Tool, readonly string[]> = {
  dm_open: ["recipientId"],
  dm_list: ["after", "limit"],
  dm_send: ["channelId", "text", "replyTo", "attachmentIds", "branchId"],
  channel_post: [
    "channelId",
    "text",
    "recipientId",
    "replyTo",
    "attachmentIds",
    "branchId",
  ],
  kanban_boards: ["after", "limit"],
  kanban_list: ["boardId", "after", "limit"],
  kanban_get: ["taskId"],
  kanban_create: [
    "maxRetries",
    "boardId",
    "title",
    "body",
    "assignee",
    "priority",
    "parentId",
    "completionContract",
  ],
  kanban_update: [
    "maxRetries",
    "taskId",
    "expectedRevision",
    "title",
    "body",
    "assignee",
    "priority",
    "parentId",
    "completionContract",
    "dependencies",
  ],
  kanban_prepare: ["taskId", "expectedRevision", "reason"],
  kanban_comment: ["taskId", "body"],
};
function invoke(
  tasks: TaskStore,
  tool: Tool,
  args: Record<string, unknown>,
  profileId: string,
  idempotencyKey: string,
  messaging: MessagingStore | undefined,
  runId: string,
): unknown {
  const { taskId, boardId, ...rest } = args;
  switch (tool) {
    case "dm_open":
      if (!messaging) fail(503, "unavailable");
      return messaging.openDm({
        senderId: `agent:${profileId}`,
        recipientId: string(args.recipientId),
      });
    case "dm_list":
      if (!messaging) fail(503, "unavailable");
      return messaging.listChannels({
        ...(args as PageInput),
        memberId: `agent:${profileId}`,
        kind: "dm",
      });
    case "dm_send":
    case "channel_post": {
      if (!messaging) fail(503, "unavailable");
      const channelId = string(args.channelId);
      if (
        messaging.getChannel(channelId).kind !==
        (tool === "dm_send" ? "dm" : "channel")
      )
        fail(400, "invalid");
      return messaging.postAgentMessage({
        ...args,
        channelId,
        runId,
        profileId,
        idempotencyKey,
      } as PostAgentMessage);
    }
    case "kanban_boards": {
      const page = tasks.listBoards(args as PageInput);
      return {
        ...page,
        items: page.items.map(
          ({ id, name, archived, dispatchMode, revision }) => ({
            id,
            name,
            archived,
            dispatchMode,
            revision,
          }),
        ),
      };
    }
    case "kanban_list": {
      const page = tasks.listTasks(string(boardId), rest as PageInput);
      return {
        ...page,
        items: page.items.map(
          ({
            id,
            boardId,
            title,
            status,
            assignee,
            priority,
            parentId,
            revision,
            routineOccurrenceId,
          }) => ({
            id,
            boardId,
            title,
            status,
            assignee,
            priority,
            parentId,
            revision,
            ...(routineOccurrenceId ? { routineOccurrenceId } : {}),
          }),
        ),
      };
    }
    case "kanban_get":
      return tasks.getTask(string(taskId));
    case "kanban_create":
      return tasks.createTask({
        ...args,
        idempotencyKey,
      } as unknown as CreateTask);
    case "kanban_comment":
      return tasks.addComment(string(taskId), {
        body: args.body as string,
        author: profileId,
        idempotencyKey,
      });
    case "kanban_update":
    case "kanban_prepare": {
      const id = string(taskId);
      if (tasks.getTask(id).routineOccurrenceId) fail(403, "forbidden");
      if (tool === "kanban_update")
        return tasks.updateTask(id, {
          ...rest,
          idempotencyKey,
        } as unknown as UpdateTask);
      return tasks.transitionTask(id, {
        ...rest,
        status: "ready",
        agentPreparation: true,
        author: profileId,
        idempotencyKey,
      } as unknown as Parameters<TaskStore["transitionTask"]>[1]);
    }
  }
}
export async function startAgentToolServer({
  tasks,
  messaging,
  onResult,
  onBeforeTaskAction,
}: {
  tasks: TaskStore;
  messaging?: MessagingStore;
  onBeforeTaskAction?: (event: {
    runId: string;
    profileId: string;
    tool: "kanban_create" | "kanban_prepare";
    idempotencyKey: string;
  }) => void;
  onResult?: (event: {
    runId: string;
    profileId: string;
    tool: string;
    result: unknown;
  }) => void;
}): Promise<AgentToolServer> {
  type Scope = {
    runId: string;
    profileId: string;
    tools: Set<Tool>;
    signal: AbortSignal;
    revoke: () => void;
  };
  const leases = new Map<string, Scope>();
  const calls = new Map<
    string,
    Map<string, { identity: string; result?: unknown; completed: boolean }>
  >();
  let closed = false;
  let closing: Promise<void> | undefined;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.setHeader("Cache-Control", "no-store");
    const timer = setTimeout(() => request.destroy(), 10_000);
    timer.unref();
    try {
      if (request.headers.origin !== undefined) fail(403, "forbidden");
      if (request.method !== "POST" || request.url !== "/invoke")
        fail(404, "not_found");
      const token = request.headers.authorization?.match(
        /^Bearer ([A-Za-z0-9_-]+)$/,
      )?.[1];
      const scope = token ? leases.get(token) : undefined;
      if (!scope || scope.signal.aborted) fail(401, "unauthorized");
      const input = object(await body(request), ["tool", "callId", "args"]);
      if (closed || leases.get(token!) !== scope || scope.signal.aborted)
        fail(401, "unauthorized");
      const tool = string(input.tool) as Tool;
      if (!scope.tools.has(tool)) fail(403, "forbidden");
      const callId = string(input.callId);
      const args = object(input.args, fields[tool]);
      const identity = canonical({ tool, args, profileId: scope.profileId });
      if (
        !tasks.admitAgentToolCall({
          runId: scope.runId,
          callId,
          identityHash: createHash("sha256").update(identity).digest("hex"),
        })
      )
        fail(429, "call_limit");
      let runCalls = calls.get(scope.runId);
      if (!runCalls) {
        runCalls = new Map();
        calls.set(scope.runId, runCalls);
      }
      let call = runCalls.get(callId);
      if (call && call.identity !== identity) fail(409, "conflict");
      if (!call) {
        call = { identity, completed: false };
        runCalls.set(callId, call);
      }
      if (!call.completed) {
        const key = createHash("sha256")
          .update(JSON.stringify([scope.runId, callId, tool]))
          .digest("hex");
        if (tool === "kanban_create" || tool === "kanban_prepare")
          onBeforeTaskAction?.({
            runId: scope.runId,
            profileId: scope.profileId,
            tool,
            idempotencyKey: key,
          });
        call.result = invoke(
          tasks,
          tool,
          args,
          scope.profileId,
          key,
          messaging,
          scope.runId,
        );
        call.completed = true;
      }
      onResult?.({
        runId: scope.runId,
        profileId: scope.profileId,
        tool,
        result: call.result,
      });
      const output = JSON.stringify(call.result);
      if (Buffer.byteLength(output) > 512 * 1024) fail(413, "too_large");
      response.writeHead(200);
      response.end(output);
    } catch (error) {
      let status = 503;
      let code = "unavailable";
      if (error instanceof RequestError) {
        status = error.status;
        code = error.code;
      } else if (
        error instanceof TaskError ||
        error instanceof RuntimeError ||
        error instanceof MessagingError
      ) {
        if (error.code === "invalid") {
          status = 400;
          code = "invalid";
        } else if (error.code === "not_found") {
          status = 404;
          code = "not_found";
        } else if (error.code === "conflict") {
          status = 409;
          code = "conflict";
        }
      }
      response.writeHead(status);
      response.end(JSON.stringify({ error: code }));
    } finally {
      clearTimeout(timer);
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Invalid loopback address");
  const url = `http://127.0.0.1:${address.port}/invoke`;
  return {
    open({ runId, profileId, tools, signal }) {
      if (closed) throw new TaskError("closed", "Task tool server closed");
      string(runId);
      string(profileId);
      const permitted = AGENT_TOOLS.filter((tool) => tools.includes(tool));
      if (
        !messaging &&
        permitted.some((tool) =>
          (AGENT_MESSAGE_TOOLS as readonly string[]).includes(tool),
        )
      )
        throw new RuntimeError("unavailable", "Agent messaging is unavailable");
      const token = randomBytes(32).toString("base64url");
      const revoke = () => {
        leases.delete(token);
        if (![...leases.values()].some((scope) => scope.runId === runId))
          calls.delete(runId);
        signal.removeEventListener("abort", revoke);
      };
      if (!signal.aborted) {
        leases.set(token, {
          runId,
          profileId,
          tools: new Set(permitted),
          signal,
          revoke,
        });
        signal.addEventListener("abort", revoke, { once: true });
      }
      return { url, token, tools: [...permitted], close: revoke };
    },
    close() {
      if (!closing) {
        closed = true;
        for (const scope of leases.values()) scope.revoke();
        calls.clear();
        closing = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      }
      return closing;
    },
  };
}
