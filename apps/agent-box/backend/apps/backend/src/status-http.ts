import type { IncomingMessage } from "node:http";
import { RuntimeError } from "@mindi/agent-runtime";
import type { StatusProjection } from "./status-projection.js";
export async function routeStatus(
  status: StatusProjection,
  request: IncomingMessage,
  url: URL,
) {
  if (!["/status", "/status/activity"].includes(url.pathname)) return;
  if (request.method !== "GET")
    throw new RuntimeError("invalid", "Status is read-only");
  const keys = [...url.searchParams.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some(
      (k) =>
        !(
          ["/status/activity"].includes(url.pathname)
            ? ["limit", "after", "profileId"]
            : []
        ).includes(k),
    )
  )
    throw new RuntimeError("invalid", "Invalid status query");
  if (url.pathname === "/status") return { value: await status.read() };
  const limit = url.searchParams.get("limit");
  if (limit !== null && !/^[1-9][0-9]{0,2}$/.test(limit))
    throw new RuntimeError("invalid", "Invalid activity limit");
  return {
    value: status.activity({
      ...(limit !== null ? { limit: Number(limit) } : {}),
      ...(url.searchParams.has("after")
        ? { after: url.searchParams.get("after")! }
        : {}),
      ...(url.searchParams.has("profileId")
        ? { profileId: url.searchParams.get("profileId")! }
        : {}),
    }),
  };
}
