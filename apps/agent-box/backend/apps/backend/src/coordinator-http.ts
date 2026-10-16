import type { IncomingMessage } from "node:http";
import { RuntimeError } from "@mindi/agent-runtime";
import { readJsonBody } from "./http-body.js";
import type { CoordinatorUpdates } from "./coordinator-updates.js";

/** Called only behind the backend's operator bearer authentication. */
export async function routeCoordinatorUpdates(
  updates: CoordinatorUpdates | undefined,
  request: IncomingMessage,
  url: URL,
) {
  if (
    url.pathname !== "/coordinator/updates" &&
    url.pathname !== "/coordinator/updates/retry"
  )
    return;
  if (!updates)
    throw new RuntimeError("unavailable", "Pi coordinator is not configured");
  if (url.search)
    throw new RuntimeError(
      "invalid",
      "Coordinator update queries are not supported",
    );
  if (url.pathname === "/coordinator/updates" && request.method === "GET")
    return { value: { items: updates.listAttention() } };
  if (
    url.pathname === "/coordinator/updates/retry" &&
    request.method === "POST"
  ) {
    const input = await readJsonBody(request, [
      "taskId",
      "threadId",
      "expectedRunId",
      "idempotencyKey",
    ]);
    for (const [key, value] of Object.entries(input))
      if (
        !(key === "expectedRunId" && value === null) &&
        (typeof value !== "string" || !value.trim() || value.length > 200)
      )
        throw new RuntimeError("invalid", "Invalid coordinator retry identity");
    if (Object.keys(input).length !== 4)
      throw new RuntimeError(
        "invalid",
        "Coordinator retry requires all identities",
      );
    return {
      value: await updates.retry(
        input as {
          taskId: string;
          threadId: string;
          expectedRunId: string | null;
          idempotencyKey: string;
        },
      ),
    };
  }
  throw new RuntimeError("not_found", "Unknown coordinator update operation");
}
