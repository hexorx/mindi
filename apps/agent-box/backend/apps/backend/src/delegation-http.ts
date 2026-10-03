import type { IncomingMessage } from "node:http";
import { RuntimeError } from "@mindi/agent-runtime";
import { readJsonBody } from "./http-body.js";
import type { DelegationService } from "./delegation-service.js";
export async function routeDelegations(
  service: DelegationService,
  request: IncomingMessage,
  url: URL,
) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "delegations") return;
  if (
    parts.length > 3 ||
    (parts.length === 3 && !["viewer", "viewer-history"].includes(parts[2]!))
  )
    return;
  const keys = [...url.searchParams.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((k) => !["limit", "after"].includes(k)) ||
    (parts.length === 3 && parts[2] === "viewer" && keys.length)
  )
    throw new RuntimeError("invalid", "Invalid delegation query");
  const limit = url.searchParams.get("limit");
  if (limit !== null && !/^[1-9][0-9]{0,2}$/.test(limit))
    throw new RuntimeError("invalid", "Invalid delegation limit");
  if (request.method === "GET" && parts.length === 1)
    return {
      value: await service.list({
        ...(limit === null ? {} : { limit: Number(limit) }),
        ...(url.searchParams.has("after")
          ? { after: url.searchParams.get("after")! }
          : {}),
      }),
    };
  const activity = parts.length === 2 && parts[1] === "activity";
  if (activity || (parts.length === 3 && parts[2] === "viewer-history")) {
    const after = url.searchParams.get("after");
    if (
      request.method !== "GET" ||
      (limit !== null && Number(limit) > 100) ||
      (after !== null &&
        (!/^(0|[1-9][0-9]{0,15})$/.test(after) ||
          !Number.isSafeInteger(Number(after))))
    )
      throw new RuntimeError("invalid", "Invalid viewer history request");
    return {
      value: activity
        ? await service.viewerActivity(
            after === null ? 0 : Number(after),
            limit === null ? 100 : Number(limit),
          )
        : await service.viewerHistory(
            parts[1]!,
            after === null ? 0 : Number(after),
            limit === null ? 100 : Number(limit),
          ),
    };
  }
  if (request.method === "GET" && parts.length === 2) {
    const after = url.searchParams.get("after");
    if (after !== null && !/^(0|[1-9][0-9]{0,15})$/.test(after))
      throw new RuntimeError("invalid", "Invalid delegation cursor");
    return {
      value: await service.read(
        parts[1]!,
        after === null ? 0 : Number(after),
        limit === null ? 100 : Number(limit),
      ),
    };
  }
  if (
    parts.length === 3 &&
    (request.method === "POST" || request.method === "DELETE")
  ) {
    await readJsonBody(request, []);
    return {
      value:
        request.method === "POST"
          ? await service.openViewer(parts[1]!)
          : await service.closeViewer(parts[1]!),
    };
  }
  throw new RuntimeError("invalid", "Unsupported delegation operation");
}
