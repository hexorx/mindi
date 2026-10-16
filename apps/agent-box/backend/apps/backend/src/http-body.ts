import type { IncomingMessage } from "node:http";
import { RuntimeError } from "@mindi/agent-runtime";
export async function readJsonBody(
  request: IncomingMessage,
  keys: string[],
): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new RuntimeError("invalid", "Expected JSON");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > 160 * 1024)
      throw new RuntimeError("invalid", "Request too large");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RuntimeError("invalid", "Invalid JSON");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new RuntimeError("invalid", "Unexpected request fields");
  return value as Record<string, unknown>;
}
