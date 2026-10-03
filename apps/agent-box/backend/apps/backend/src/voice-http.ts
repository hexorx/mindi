import type { IncomingMessage } from "node:http";
import { RuntimeError } from "@mindi/agent-runtime";
import { readJsonBody } from "./http-body.js";
import type { VoiceService } from "./voice-service.js";
export async function routeVoice(
  voice: VoiceService | undefined,
  request: IncomingMessage,
  url: URL,
) {
  if (url.pathname !== "/api/voice" && !url.pathname.startsWith("/api/voice/"))
    return;
  if (url.pathname === "/api/voice/transcripts" && request.method === "GET") {
    const input: { before?: number; after?: number; limit?: number } = {};
    for (const [key, value] of url.searchParams) {
      if (
        !["before", "after", "limit"].includes(key) ||
        key in input ||
        !/^[1-9][0-9]*$/.test(value)
      )
        throw new RuntimeError("invalid", "Invalid transcript page");
      input[key as keyof typeof input] = Number(value);
    }
    if (!voice)
      throw new RuntimeError("unavailable", "Voice is not configured");
    return { value: voice.transcripts(input) };
  }
  if (url.search)
    throw new RuntimeError("invalid", "Voice queries are not supported");
  if (url.pathname === "/api/voice" && request.method === "GET")
    return {
      value: voice?.status() ?? {
        enabled: false,
        active: false,
        activity: { state: "idle", pendingInteractions: 0, runId: null },
        threadId: null,
        profileId: null,
      },
    };
  if (!voice) throw new RuntimeError("unavailable", "Voice is not configured");
  const input = await readJsonBody(
    request,
    url.pathname === "/api/voice/calls" ? ["sdp", "clientId"] : ["clientId"],
  );
  if (
    typeof input.clientId !== "string" ||
    !input.clientId.trim() ||
    input.clientId.length > 128
  )
    throw new RuntimeError("invalid", "Invalid call client");
  if (url.pathname === "/api/voice/calls" && request.method === "POST") {
    if (typeof input.sdp !== "string")
      throw new RuntimeError("invalid", "Invalid SDP");
    return {
      status: 201,
      value: await voice.start({ sdp: input.sdp, clientId: input.clientId }),
    };
  }
  const match = /^\/api\/voice\/calls\/([a-zA-Z0-9-]+)(\/heartbeat)?$/.exec(
    url.pathname,
  );
  if (match && match[2] && request.method === "POST") {
    voice.heartbeat(match[1]!, input.clientId);
    return { value: { ok: true } };
  }
  if (match && !match[2] && request.method === "DELETE") {
    await voice.end(match[1]!, input.clientId);
    return { value: { ok: true } };
  }
  throw new RuntimeError("not_found", "Unknown voice operation");
}
