import { routeChannelBranches, branchPage } from "./channel-branch-http.js";
import type { IncomingMessage } from "node:http";
import type { MessageRunner } from "@mindi/message-runner";
import {
  MessagingError,
  type MessagingStore,
  type CreateChannel,
  type UpdateChannel,
  type PostMessage,
  type PublishDeploymentNotification,
  type Delivery,
} from "@mindi/messaging";
import { readJsonBody } from "./http-body.js";

function page(url: URL, members = false, extra: string[] = []) {
  const allowed = [
    "after",
    "limit",
    ...(members ? ["memberId"] : []),
    ...extra,
  ];
  for (const key of url.searchParams.keys())
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new MessagingError("invalid", "Invalid page query");
  const after = url.searchParams.get("after");
  const limit = url.searchParams.get("limit");
  const memberId = url.searchParams.get("memberId");
  return {
    ...(after === null ? {} : { after }),
    ...(limit === null ? {} : { limit: Number(limit) }),
    ...(memberId === null ? {} : { memberId }),
  };
}
export async function routeMessaging(
  store: MessagingStore,
  request: IncomingMessage,
  url: URL,
  runner?: MessageRunner,
): Promise<{ status: number; value: unknown } | undefined> {
  if (url.pathname === "/deployment-notifications") {
    if (request.method !== "POST" || url.search)
      throw new MessagingError(
        "invalid",
        "Invalid deployment notification request",
      );
    const message = store.publishDeploymentNotification(
      (await readJsonBody(request, [
        "channelId",
        "eventId",
        "deploymentId",
        "connectionId",
        "endpoint",
        "result",
        "occurredAt",
        "name",
        "image",
      ])) as unknown as PublishDeploymentNotification,
    );
    return {
      status: 200,
      value: {
        channelId: message.channelId,
        messageId: message.id,
        source: message.deploymentNotification,
      },
    };
  }
  const branchResult = await routeChannelBranches(store, request, url, runner);
  if (branchResult) return branchResult;
  const parts = url.pathname.split("/").filter(Boolean);
  const [resource, id, action] = parts;
  const get = request.method === "GET",
    post = request.method === "POST";
  if (
    resource === "messaging" &&
    id === "status" &&
    parts.length === 2 &&
    get &&
    runner
  )
    return { status: 200, value: runner.status() };
  if (resource === "deliveries") {
    if (parts.length === 1 && get) {
      const pagination = page(url, false, ["channelId", "state", "branchId"]);
      const channelId = url.searchParams.get("channelId"),
        state = url.searchParams.get("state"),
        branchId = url.searchParams.get("branchId");
      return {
        status: 200,
        value: store.listDeliveries({
          ...pagination,
          ...(channelId === null ? {} : { channelId }),
          ...(branchId === null ? {} : { branchId }),
          ...(state === null ? {} : { states: [state as Delivery["state"]] }),
        }),
      };
    }
    if (id && parts.length === 2 && get)
      return { status: 200, value: store.getDelivery(id) };
    if (id && action === "cancel" && parts.length === 3 && post && runner) {
      await readJsonBody(request, []);
      return { status: 200, value: runner.cancel(id) };
    }
  }
  if (resource === "channels") {
    if (parts.length === 1) {
      if (get)
        return { status: 200, value: store.listChannels(page(url, true)) };
      if (post)
        return {
          status: 201,
          value: store.createChannel(
            (await readJsonBody(request, [
              "name",
              "members",
              "coordinatorId",
              "idempotencyKey",
            ])) as unknown as CreateChannel,
          ),
        };
    }
    if (id && parts.length === 2) {
      if (get) return { status: 200, value: store.getChannel(id) };
      if (request.method === "PATCH")
        return {
          status: 200,
          value: store.updateChannel(
            id,
            (await readJsonBody(request, [
              "expectedRevision",
              "name",
              "members",
              "coordinatorId",
            ])) as unknown as UpdateChannel,
          ),
        };
    }
    if (id && parts.length === 3 && action === "messages") {
      if (get) {
        const page = store.listMessages(id, branchPage(url, true));
        return {
          status: 200,
          value: {
            ...page,
            items: page.items.map((message) =>
              runner ? runner.branches.projectMessage(message) : message,
            ),
          },
        };
      }
      if (post)
        return {
          status: 201,
          value: store.postMessage({
            ...(await readJsonBody(request, [
              "text",
              "attachmentIds",
              "recipientId",
              "replyTo",
              "branchId",
              "idempotencyKey",
            ])),
            channelId: id,
            senderId: "operator",
          } as PostMessage),
        };
    }
  }
  if (resource === "dms" && parts.length === 1 && post) {
    const input = await readJsonBody(request, ["recipientId"]);
    return {
      status: 201,
      value: store.openDm({
        senderId: "operator",
        recipientId: input.recipientId as string,
      }),
    };
  }
  if (resource === "messages" && id && parts.length === 2 && get)
    return { status: 200, value: store.getMessage(id) };
}
