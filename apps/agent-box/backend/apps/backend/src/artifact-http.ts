import type { IncomingMessage } from "node:http";
import { ArtifactStore, ArtifactError } from "./artifacts.js";
import { readJsonBody } from "./http-body.js";
export async function routeArtifacts(
  store: ArtifactStore,
  request: IncomingMessage,
  url: URL,
) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "profiles" || !parts[1] || parts[2] !== "artifacts") return;
  const profileId = parts[1],
    id = parts[3];
  const listing = parts.length === 3 && request.method === "GET";
  for (const key of url.searchParams.keys())
    if (
      !listing ||
      !["limit", "after"].includes(key) ||
      url.searchParams.getAll(key).length !== 1
    )
      throw new ArtifactError("invalid", "Invalid artifact query.");
  if (listing)
    return {
      status: 200,
      value: store.list(profileId, {
        ...(url.searchParams.has("limit")
          ? { limit: Number(url.searchParams.get("limit")) }
          : {}),
        ...(url.searchParams.has("after")
          ? { after: url.searchParams.get("after")! }
          : {}),
      }),
    };
  if (parts.length === 3 && request.method === "POST") {
    const body = await readJsonBody(request, ["path", "idempotencyKey"]);
    return {
      status: 201,
      value: await store.acquire({
        profileId,
        path: body.path as string,
        idempotencyKey: body.idempotencyKey as string,
      }),
    };
  }
  if (parts.length === 4 && id === "capability" && request.method === "GET")
    return { status: 200, value: store.capability(profileId) };
  if (parts.length === 4 && id && request.method === "GET")
    return { status: 200, value: store.get(profileId, id) };
  if (
    parts.length === 5 &&
    id &&
    parts[4] === "content" &&
    request.method === "GET"
  )
    return { status: 200, value: store.content(profileId, id) };
}
