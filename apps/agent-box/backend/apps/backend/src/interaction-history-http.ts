import type { IncomingMessage } from "node:http";
import { RuntimeError, type AgentRuntime } from "@mindi/agent-runtime";

export function routeInteractionHistory(
  runtime: AgentRuntime,
  request: IncomingMessage,
  url: URL,
) {
  if (
    !["/activity/interactions", "/activity/interactions/current"].includes(
      url.pathname,
    )
  )
    return;
  if (request.method !== "GET")
    throw new RuntimeError("invalid", "Interaction history is read-only");
  if (url.pathname.endsWith("/current")) {
    if ([...url.searchParams].length)
      throw new RuntimeError(
        "invalid",
        "Current interaction query is not supported",
      );
    return { value: runtime.currentInteractions() };
  }
  const keys = [...url.searchParams.keys()];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !["limit", "after"].includes(key))
  )
    throw new RuntimeError("invalid", "Invalid interaction history query");
  const limit = url.searchParams.get("limit");
  if (limit !== null && !/^[1-9][0-9]{0,2}$/.test(limit))
    throw new RuntimeError("invalid", "Invalid interaction history limit");
  return {
    value: runtime.pageInteractionHistory({
      ...(limit !== null ? { limit: Number(limit) } : {}),
      ...(url.searchParams.has("after")
        ? { after: url.searchParams.get("after")! }
        : {}),
    }),
  };
}
