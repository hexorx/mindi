import type { TaskDispatcher, TaskRunner } from "@mindi/task-runner";
import type { IncomingMessage } from "node:http";
import { RuntimeError } from "@mindi/agent-runtime";
import type { TaskStore, CreateTask, PageInput } from "@mindi/tasks";
import { readJsonBody } from "./http-body.js";
import type { TaskDiscussionPublisher } from "./task-discussions.js";
function page(
  url: URL,
  archive = false,
): PageInput & { includeArchived?: boolean } {
  const keys = ["after", "limit", ...(archive ? ["includeArchived"] : [])];
  for (const key of url.searchParams.keys())
    if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new RuntimeError("invalid", "Invalid page query");
  const after = url.searchParams.get("after");
  const limit = url.searchParams.get("limit");
  const archived = url.searchParams.get("includeArchived");
  if (archived !== null && archived !== "true" && archived !== "false")
    throw new RuntimeError("invalid", "Invalid archive filter");
  return {
    ...(after !== null ? { after } : {}),
    ...(limit !== null ? { limit: Number(limit) } : {}),
    ...(archived !== null ? { includeArchived: archived === "true" } : {}),
  };
}
export async function routeTasks(
  tasks: TaskStore,
  request: IncomingMessage,
  url: URL,
  runner?: TaskRunner,
  dispatcher?: TaskDispatcher,
  taskDiscussionPublisher?: TaskDiscussionPublisher,
): Promise<{ status: number; value: unknown } | undefined> {
  const parts = url.pathname.split("/").filter(Boolean);
  const [resource, id, action] = parts;
  const get = request.method === "GET",
    post = request.method === "POST";
  if (resource === "tasks" && id && action === "discussion") {
    if (parts.length === 3 && get) {
      if (url.search)
        throw new RuntimeError("invalid", "Discussion takes no query");
      return {
        status: 200,
        value: { discussion: tasks.getTaskDiscussion(id) ?? null },
      };
    }
    if (parts.length === 4 && parts[3] === "comments") {
      if (get)
        return {
          status: 200,
          value: tasks.listDiscussionComments(id, page(url)),
        };
      if (post) {
        if (url.search)
          throw new RuntimeError(
            "invalid",
            "Discussion admission takes no query",
          );
        const input = await readJsonBody(request, [
          "channelId",
          "body",
          "idempotencyKey",
        ]);
        const saved = tasks.addDiscussionComment(id, {
          ...input,
          author: "operator",
        } as Parameters<TaskStore["addDiscussionComment"]>[1]);
        // Admission is durable before projection; a failed projection must not
        // turn a saved comment into an apparent HTTP admission failure.
        try {
          await taskDiscussionPublisher?.tick();
        } catch {
          // The persisted pending receipt is retried by the application loop.
        }
        return {
          status: 201,
          value: {
            comment: saved.comment,
            discussion: tasks.getTaskDiscussion(id) ?? saved.discussion,
          },
        };
      }
    }
  }
  if (
    dispatcher &&
    resource === "boards" &&
    id &&
    action === "dispatch" &&
    parts.length === 3 &&
    get
  ) {
    if (url.search)
      throw new RuntimeError("invalid", "Dispatch status takes no query");
    return { status: 200, value: dispatcher.status(id) };
  }
  if (resource === "boards" && parts.length === 1) {
    if (get) return { status: 200, value: tasks.listBoards(page(url, true)) };
    if (post)
      return {
        status: 201,
        value: tasks.createBoard(
          (await readJsonBody(request, [
            "name",
            "description",
            "messagingChannelId",
            "idempotencyKey",
          ])) as unknown as Parameters<TaskStore["createBoard"]>[0],
        ),
      };
  }
  if (
    resource === "boards" &&
    id &&
    parts.length === 2 &&
    request.method === "PATCH"
  )
    return {
      status: 200,
      value: tasks.updateBoard(
        id,
        (await readJsonBody(request, [
          "expectedRevision",
          "name",
          "description",
          "messagingChannelId",
          "archived",
          "dispatchMode",
        ])) as unknown as Parameters<TaskStore["updateBoard"]>[1],
      ),
    };
  if (resource === "boards" && id && parts.length === 2 && get)
    return { status: 200, value: tasks.getBoard(id) };
  if (resource === "boards" && id && action === "tasks" && parts.length === 3) {
    if (get)
      return { status: 200, value: tasks.listTasks(id, page(url, true)) };
    if (post) {
      const input = await readJsonBody(request, [
        "maxRetries",
        "title",
        "body",
        "assignee",
        "priority",
        "parentId",
        "completionContract",
        "status",
        "idempotencyKey",
      ]);
      return {
        status: 201,
        value: tasks.createTask({
          ...input,
          boardId: id,
        } as unknown as CreateTask),
      };
    }
  }
  if (resource === "tasks" && id && parts.length === 2 && get)
    return { status: 200, value: tasks.getTask(id) };
  if (
    resource === "tasks" &&
    id &&
    parts.length === 2 &&
    request.method === "PATCH"
  ) {
    const input = await readJsonBody(request, [
      "maxRetries",
      "expectedRevision",
      "title",
      "body",
      "assignee",
      "priority",
      "parentId",
      "completionContract",
      "dependencies",
    ]);
    return {
      status: 200,
      value: tasks.updateTask(
        id,
        input as unknown as Parameters<TaskStore["updateTask"]>[1],
      ),
    };
  }
  if (resource === "tasks" && id && parts.length === 3) {
    if (action === "comments") {
      if (get) return { status: 200, value: tasks.listComments(id, page(url)) };
      if (post) {
        const input = await readJsonBody(request, ["body", "idempotencyKey"]);
        return {
          status: 201,
          value: tasks.addComment(id, {
            ...input,
            author: "operator",
          } as Parameters<TaskStore["addComment"]>[1]),
        };
      }
    }
    if (action === "activity" && get)
      return { status: 200, value: tasks.listActivity(id, page(url)) };
    if (action === "attempts" && get)
      return { status: 200, value: tasks.listAttempts(id, page(url)) };
    if (action === "transition" && post)
      return {
        status: 200,
        value: tasks.transitionTask(
          id,
          (await readJsonBody(request, [
            "expectedRevision",
            "status",
            "reason",
          ])) as unknown as Parameters<TaskStore["transitionTask"]>[1],
        ),
      };
    if (action === "review" && post)
      return {
        status: 200,
        value: tasks.reviewTask(
          id,
          (await readJsonBody(request, [
            "expectedRevision",
            "decision",
            "reason",
          ])) as unknown as Parameters<TaskStore["reviewTask"]>[1],
        ),
      };
  }
  if (runner && resource === "tasks" && id && parts.length === 3 && post) {
    if (action === "dispatch" || action === "decompose")
      return {
        status: 202,
        value: runner[action](
          id,
          (await readJsonBody(request, [
            "expectedRevision",
            "idempotencyKey",
          ])) as unknown as Parameters<TaskRunner["dispatch"]>[1],
        ),
      };
    if (action === "reconcile")
      return {
        status: 200,
        value: runner.reconcile(
          id,
          (await readJsonBody(request, [
            "expectedRevision",
            "reason",
            "confirmStopped",
          ])) as unknown as Parameters<TaskRunner["reconcile"]>[1],
        ),
      };
  }
  if (
    runner &&
    resource === "attempts" &&
    id &&
    action === "cancel" &&
    parts.length === 3 &&
    post
  ) {
    await readJsonBody(request, []);
    return { status: 202, value: runner.cancel(id) };
  }
  return undefined;
}
