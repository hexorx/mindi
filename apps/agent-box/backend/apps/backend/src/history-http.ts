import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  RuntimeError,
  type AgentRuntime,
  type Thread,
  type ThreadPageInput,
} from "@mindi/agent-runtime";

export function publicThread(thread: Thread, preview?: string) {
  return {
    id: thread.id,
    profileId: thread.profileId,
    createdAt: thread.createdAt,
    ...(thread.replyContext ? { replyContext: thread.replyContext } : {}),
    ...(preview ? { preview } : {}),
    owner: thread.owner ?? { kind: "unresolved" },
    ownershipRevision: createHash("sha256")
      .update(JSON.stringify(thread))
      .digest("hex"),
    ...(thread.parentId
      ? { parentId: thread.parentId, branchEntryId: thread.branchEntryId }
      : {}),
  };
}

/** Explicit page opt-in preserves the legacy array shape without unbounded reads. */
export function routeHistory(
  runtime: AgentRuntime,
  request: IncomingMessage,
  url: URL,
): { value: unknown; headers?: Record<string, string> } | undefined {
  const parts = url.pathname.split("/").filter(Boolean);
  const threads = url.pathname === "/threads";
  const runs =
    parts.length === 3 && parts[0] === "threads" && parts[2] === "runs";
  const current =
    parts.length === 4 &&
    parts[0] === "threads" &&
    parts[2] === "runs" &&
    parts[3] === "current";
  if (!threads && !runs && !current) return;
  if (request.method !== "GET") {
    if (url.search)
      throw new RuntimeError("invalid", "History queries are read-only");
    return;
  }
  const threadId = parts[1]!;
  if (current) {
    if (url.search)
      throw new RuntimeError(
        "invalid",
        "Current runs do not accept history queries",
      );
    return { value: runtime.currentRuns(threadId) };
  }
  if (!url.search) {
    const result = threads
      ? runtime.legacyThreadList()
      : runtime.legacyRunList(threadId);
    return {
      value: threads
        ? (result.items as Thread[]).map((thread) =>
            publicThread(thread, runtime.threadPreview(thread.id)),
          )
        : result.items,
      headers: {
        "x-mindi-history-truncated": String(result.truncated),
        "x-mindi-history-limit": "1000",
        link: `<${url.pathname}?page=1>; rel="successor-version"`,
        deprecation: "@1788825600",
      },
    };
  }
  const allowed = threads
    ? ["page", "limit", "after", "profileId", "ownerKind"]
    : ["page", "limit", "after"];
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1)
      throw new RuntimeError("invalid", "Invalid history page query");
  }
  if (url.searchParams.get("page") !== "1")
    throw new RuntimeError("invalid", "History queries require page=1");
  const limit = url.searchParams.get("limit"),
    after = url.searchParams.get("after");
  if (limit !== null && !/^[0-9]+$/.test(limit))
    throw new RuntimeError("invalid", "Invalid history page limit");
  const input = {
    ...(limit === null ? {} : { limit: Number(limit) }),
    ...(after === null ? {} : { after }),
  };
  if (threads) {
    const profileId = url.searchParams.get("profileId"),
      ownerKind = url.searchParams.get("ownerKind");
    const result = runtime.pageThreads({
      ...input,
      ...(profileId === null ? {} : { profileId }),
      ...(ownerKind === null
        ? {}
        : { ownerKind: ownerKind as ThreadPageInput["ownerKind"] }),
    });
    return {
      value: {
        ...result,
        items: result.items.map((thread) =>
          publicThread(thread, runtime.threadPreview(thread.id)),
        ),
      },
    };
  }
  return { value: runtime.pageRuns(threadId, input) };
}
