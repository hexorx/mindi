import type { IncomingMessage } from "node:http";
import {
  MessagingError,
  type MessagingStore,
  type CreateBranch,
} from "@mindi/messaging";
import type { MessageRunner } from "@mindi/message-runner";
import { readJsonBody } from "./http-body.js";
export function branchPage(url: URL, allowBranch = false) {
  for (const key of url.searchParams.keys())
    if (
      !["after", "limit", ...(allowBranch ? ["branchId"] : [])].includes(key) ||
      url.searchParams.getAll(key).length !== 1
    )
      throw new MessagingError("invalid", "Invalid branch query");
  const after = url.searchParams.get("after"),
    limit = url.searchParams.get("limit"),
    branchId = url.searchParams.get("branchId");
  return {
    ...(after === null ? {} : { after }),
    ...(limit === null ? {} : { limit: Number(limit) }),
    ...(branchId === null ? {} : { branchId }),
  };
}
export async function routeChannelBranches(
  store: MessagingStore,
  request: IncomingMessage,
  url: URL,
  runner?: MessageRunner,
) {
  const parts = url.pathname.split("/").filter(Boolean),
    [resource, id, action] = parts;
  const get = request.method === "GET",
    post = request.method === "POST";
  if (resource === "channels" && id) {
    if (parts.length === 3 && action === "threads" && get && runner)
      return {
        status: 200,
        value: runner.branches.threads(id, branchPage(url, true)),
      };
    if (parts.length === 3 && action === "replies" && post && runner) {
      const value = await runner.branches.reply({
        ...(await readJsonBody(request, [
          "parentMessageId",
          "profileId",
          "parentBranchId",
          "idempotencyKey",
        ])),
        channelId: id,
      } as Parameters<typeof runner.branches.reply>[0]);
      return { status: value.fork.state === "pending" ? 202 : 200, value };
    }
    if (parts.length === 3 && action === "branches") {
      if (get)
        return { status: 200, value: store.listBranches(id, branchPage(url)) };
      if (post)
        return {
          status: 201,
          value: store.createBranch({
            ...(await readJsonBody(request, [
              "name",
              "parentBranchId",
              "idempotencyKey",
            ])),
            channelId: id,
          } as CreateBranch),
        };
    }
    if (parts.length === 3 && action === "conversations" && get)
      return {
        status: 200,
        value: store.listConversations(id, branchPage(url, true)),
      };
    if (
      parts.length === 5 &&
      action === "conversations" &&
      parts[3] &&
      parts[4] === "branches" &&
      get &&
      runner
    ) {
      for (const key of url.searchParams.keys())
        if (key !== "branchId" || url.searchParams.getAll(key).length !== 1)
          throw new MessagingError("invalid", "Invalid branch query");
      const branchId = url.searchParams.get("branchId");
      return {
        status: 200,
        value: await runner.branches.points(
          id,
          parts[3],
          branchId ?? undefined,
        ),
      };
    }
  }
  if (resource === "channel-branches" && id) {
    if (parts.length === 2 && get)
      return { status: 200, value: store.getBranch(id) };
    if (parts.length === 3 && action === "forks") {
      if (get) {
        const page = store.listBranchForks(id, branchPage(url));
        return {
          status: 200,
          value: {
            ...page,
            items: page.items.map((item) =>
              runner ? runner.branches.getFork(item.id) : item,
            ),
          },
        };
      }
      if (post && runner) {
        const value = await runner.branches.fork({
          ...(await readJsonBody(request, [
            "profileId",
            "entryId",
            "idempotencyKey",
          ])),
          branchId: id,
        } as Parameters<typeof runner.branches.fork>[0]);
        return { status: value.state === "pending" ? 202 : 200, value };
      }
    }
  }
  if (
    resource === "channel-forks" &&
    id &&
    parts.length === 3 &&
    (action === "recover" || action === "retry") &&
    post &&
    runner
  ) {
    await readJsonBody(request, []);
    return {
      status: 200,
      value:
        action === "retry"
          ? await runner.branches.retryReceipt(id)
          : runner.branches.recoverReceipt(id),
    };
  }
  if (resource === "channel-forks" && id && parts.length === 2 && get)
    return {
      status: 200,
      value: runner ? runner.branches.getFork(id) : store.getBranchFork(id),
    };
  return undefined;
}
