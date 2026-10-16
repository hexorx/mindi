import type { IncomingMessage } from "node:http";
import { RuntimeError } from "@mindi/agent-runtime";
import type { AttachmentStore } from "./attachments.js";
/** Separate upload envelope; normal command routes retain their 160 KiB limit. */
async function uploadBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new RuntimeError("invalid", "Expected JSON");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += bytes.length;
    if (size > 4_100_000)
      throw new RuntimeError("invalid", "Attachment upload too large");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RuntimeError("invalid", "Invalid JSON");
  }
}
export async function routeAttachments(
  store: AttachmentStore,
  request: IncomingMessage,
  url: URL,
) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "attachments") return;
  if (url.search)
    throw new RuntimeError(
      "invalid",
      "Attachment routes do not accept query parameters",
    );
  if (parts.length === 1 && request.method === "POST")
    return { status: 201, value: store.stage(await uploadBody(request)) };
  if (parts.length === 2 && request.method === "GET")
    return { status: 200, value: store.get(parts[1]!) };
  if (parts.length === 3 && parts[2] === "content" && request.method === "GET")
    return { status: 200, value: store.content(parts[1]!) };
}
