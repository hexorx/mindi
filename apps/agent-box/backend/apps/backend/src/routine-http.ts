import type { IncomingMessage } from "node:http";
import { RoutineError, type RoutineStore } from "@mindi/routines";
import type {
  RoutineScheduler,
  RoutinePublisher,
  RoutineDeliveryPublisher,
} from "@mindi/routines";
import type { TaskStore } from "@mindi/tasks";
import { readJsonBody } from "./http-body.js";
function page(url: URL, deleted = false) {
  for (const key of url.searchParams.keys())
    if (
      !["after", "limit", ...(deleted ? ["includeDeleted"] : [])].includes(
        key,
      ) ||
      url.searchParams.getAll(key).length !== 1
    )
      throw new RoutineError("invalid", "Invalid routine page query");
  const after = url.searchParams.get("after"),
    limit = url.searchParams.get("limit"),
    include = url.searchParams.get("includeDeleted");
  if (include !== null && include !== "true" && include !== "false")
    throw new RoutineError("invalid", "Invalid deleted filter");
  return {
    ...(after !== null ? { after } : {}),
    ...(limit !== null ? { limit: Number(limit) } : {}),
    ...(include !== null ? { includeDeleted: include === "true" } : {}),
  };
}
export async function routeRoutines(
  routines: RoutineStore,
  tasks: TaskStore,
  scheduler: RoutineScheduler,
  request: IncomingMessage,
  url: URL,
  publisher?: RoutinePublisher,
  deliveryPublisher?: RoutineDeliveryPublisher,
): Promise<{ status: number; value: unknown } | undefined> {
  const parts = url.pathname.split("/").filter(Boolean);
  const [resource, id, action] = parts;
  if (resource === "routine-deliveries" && id) {
    if (url.searchParams.size)
      throw new RoutineError("invalid", "Invalid delivery query");
    if (
      parts.length === 3 &&
      request.method === "GET" &&
      action === "operations"
    )
      return { status: 200, value: routines.deliveries.progress(id) };
    if (parts.length === 2 && request.method === "GET") {
      if (id === "status" && deliveryPublisher)
        return { status: 200, value: deliveryPublisher.status() };
      return { status: 200, value: routines.deliveries.get(id) };
    }
    if (parts.length === 3 && request.method === "POST" && deliveryPublisher) {
      if (action === "retry" || action === "continue") {
        const input = await readJsonBody(request, [
          "expectedRevision",
          "idempotencyKey",
        ]);
        return {
          status: 202,
          value:
            action === "retry"
              ? deliveryPublisher.retry(
                  id,
                  input as unknown as Parameters<
                    RoutineDeliveryPublisher["retry"]
                  >[1],
                )
              : deliveryPublisher.continueOperations(
                  id,
                  input as unknown as Parameters<
                    RoutineDeliveryPublisher["continueOperations"]
                  >[1],
                ),
        };
      }
      if (action === "reconcile") {
        const input = await readJsonBody(request, ["expectedRevision"]);
        return {
          status: 200,
          value: await deliveryPublisher.reconcile(
            id,
            input as unknown as Parameters<
              RoutineDeliveryPublisher["reconcile"]
            >[1],
          ),
        };
      }
    }
  }
  if (resource === "routine-publications" && id) {
    if (parts.length === 2 && request.method === "GET") {
      if (id === "status" && publisher)
        return { status: 200, value: publisher.status() };
      const publication = routines.getPublication(id);
      if (!publication)
        throw new RoutineError("not_found", "Publication not found");
      return { status: 200, value: publication };
    }
    if (
      parts.length === 3 &&
      action === "retry" &&
      request.method === "POST" &&
      publisher
    ) {
      await readJsonBody(request, []);
      return { status: 202, value: publisher.retry(id) };
    }
  }
  if (resource !== "routines") return;
  const method = request.method;
  if (parts.length === 1) {
    if (method === "GET")
      return { status: 200, value: routines.list(page(url, true)) };
    if (method === "POST")
      return {
        status: 201,
        value: routines.create(
          (await readJsonBody(request, [
            "name",
            "prompt",
            "profileId",
            "boardId",
            "schedule",
            "enabled",
            "idempotencyKey",
            "destination",
            "deliver",
          ])) as unknown as Parameters<RoutineStore["create"]>[0],
        ),
      };
  }
  if (id && parts.length === 2) {
    if (id === "status" && method === "GET")
      return { status: 200, value: scheduler.status() };
    if (method === "GET") return { status: 200, value: routines.get(id) };
    if (method === "PATCH" || method === "DELETE") {
      const input = await readJsonBody(
        request,
        method === "DELETE"
          ? ["expectedRevision"]
          : [
              "expectedRevision",
              "name",
              "prompt",
              "schedule",
              "enabled",
              "destination",
              "deliver",
            ],
      );
      const result = routines.update(id, {
        ...input,
        ...(method === "DELETE" ? { deleted: true } : {}),
      } as unknown as Parameters<RoutineStore["update"]>[1]);
      void scheduler.tick();
      return { status: 200, value: result };
    }
  }
  if (id && parts.length === 3) {
    if (action === "external-deliveries" && method === "GET") {
      const include = url.searchParams.get("includeOperations");
      if (
        url.searchParams.getAll("includeOperations").length > 1 ||
        (include !== null && include !== "true" && include !== "false")
      )
        throw new RoutineError("invalid", "Invalid delivery progress query");
      const paging = new URL(url);
      paging.searchParams.delete("includeOperations");
      const result = routines.deliveries.list({
        ...page(paging),
        routineId: id,
      });
      return {
        status: 200,
        value: {
          ...result,
          items:
            include === "true"
              ? result.items.map((d) => {
                  const { delivery, operations, continuable } =
                    routines.deliveries.progress(d.id);
                  return {
                    ...delivery,
                    operationProgress: { operations, continuable },
                  };
                })
              : result.items,
        },
      };
    }
    if (action === "publications" && method === "GET")
      return {
        status: 200,
        value: routines.listPublications({ ...page(url), routineId: id }),
      };
    if (action === "trigger" && method === "POST") {
      const result = routines.trigger(
        id,
        (await readJsonBody(request, [
          "expectedRevision",
          "idempotencyKey",
        ])) as unknown as Parameters<RoutineStore["trigger"]>[1],
      );
      void scheduler.tick();
      return { status: 202, value: result };
    }
    if (action === "runs" && method === "GET") {
      const result = routines.listOccurrences(id, page(url));
      return {
        status: 200,
        value: {
          ...result,
          items: result.items.map((occurrence) => {
            const attempt = occurrence.attemptId
              ? tasks.getAttempt(occurrence.attemptId)
              : undefined;
            return {
              ...occurrence,
              ...(attempt?.runId ? { runId: attempt.runId } : {}),
              ...(attempt?.threadId ? { threadId: attempt.threadId } : {}),
            };
          }),
        },
      };
    }
  }
  return undefined;
}
