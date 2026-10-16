import type { IncomingMessage } from "node:http";
import { GitHubPushError, type GitHubPushes } from "./github-pushes.js";
const limitBytes = 25 * 1024 * 1024;
function one(request: IncomingMessage, name: string): string {
  const values = request.rawHeaders.filter(
    (_, index) =>
      index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === name,
  );
  const value = request.headers[name];
  if (values.length !== 1 || typeof value !== "string")
    throw new GitHubPushError("unauthorized");
  return value;
}
/** This exact inbound route has signature authority, never operator bearer authority. */
export async function receiveGitHubPush(
  store: GitHubPushes | undefined,
  request: IncomingMessage,
  url: URL,
): Promise<{ status: number; value: unknown }> {
  if (!store?.enabled) return { status: 404, value: { error: "not_found" } };
  if (request.method !== "POST")
    return { status: 405, value: { error: "method_not_allowed" } };
  if (
    url.search ||
    request.headers["content-encoding"] ||
    request.headers["content-type"]?.split(";")[0] !== "application/json"
  )
    return { status: 400, value: { error: "invalid" } };
  try {
    const signature = one(request, "x-hub-signature-256"),
      delivery = one(request, "x-github-delivery"),
      event = one(request, "x-github-event");
    if (!/^sha256=[0-9a-f]{64}$/.test(signature))
      throw new GitHubPushError("unauthorized");
    if (
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(delivery) ||
      !["push", "ping"].includes(event)
    )
      throw new GitHubPushError("invalid");
    if (Number(request.headers["content-length"] ?? 0) > limitBytes)
      return { status: 413, value: { error: "too_large" } };
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      length += chunk.length;
      if (length > limitBytes) throw new GitHubPushError("invalid");
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (event === "ping") {
      store.ping({ body, signature });
      return { status: 200, value: { ok: true } };
    }
    const receipt = store.receive({ body, signature, delivery });
    return {
      status: 202,
      value: { seq: receipt.seq, bodyHash: receipt.bodyHash },
    };
  } catch (error) {
    if (error instanceof GitHubPushError)
      return {
        status: {
          invalid: 400,
          unauthorized: 401,
          conflict: 409,
          unavailable: 503,
        }[error.code],
        value: { error: error.code },
      };
    return { status: 503, value: { error: "unavailable" } };
  }
}
export function readGitHubPushes(
  store: GitHubPushes | undefined,
  request: IncomingMessage,
  url: URL,
): { status: number; value: unknown } {
  if (!store) return { status: 404, value: { error: "not_found" } };
  if (request.method !== "GET")
    return { status: 405, value: { error: "method_not_allowed" } };
  const after = Number(url.searchParams.get("after") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 100);
  try {
    const seen = new Set<string>();
    for (const [key, value] of url.searchParams) {
      if (
        seen.has(key) ||
        !["after", "limit"].includes(key) ||
        !/^\d+$/.test(value)
      )
        throw new GitHubPushError("invalid");
      seen.add(key);
    }
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new GitHubPushError("invalid");
  } catch {
    return { status: 400, value: { error: "invalid" } };
  }
  try {
    return {
      status: 200,
      value: store.list(after, limit),
    };
  } catch {
    return { status: 503, value: { error: "unavailable" } };
  }
}
