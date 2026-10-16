import { randomBytes, createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { DesktopService } from "./service.js";
import { bindDesktopRequest, bindWindowRequest } from "./control/target.js";
import {
  DESKTOP_AGENT_TOOLS,
  type DesktopToolLease,
} from "./agent-contract.js";
export {
  DESKTOP_AGENT_TOOLS,
  type DesktopToolLease,
} from "./agent-contract.js";
export interface DesktopToolServer {
  open(input: {
    runId: string;
    profileId: string;
    tools: readonly string[];
    signal: AbortSignal;
  }): DesktopToolLease;
  close(): Promise<void>;
}
class RequestError extends Error {
  constructor(readonly status: number) {
    super("Desktop tool request rejected");
  }
}
type Reply = { status: number; body: string };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError(400);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new RequestError(400);
}
function bounded(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
async function body(request: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw new RequestError(413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch {
    throw new RequestError(400);
  }
}
function response(
  result: Record<string, unknown>,
  observation?: string,
): Reply {
  if (!Array.isArray(result.content)) throw new RequestError(503);
  const content = result.content.map((value) => {
    const block = object(value);
    if (block.type === "text" && typeof block.text === "string")
      return { type: "text", text: block.text };
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string" &&
      block.mimeType.startsWith("image/")
    )
      return { type: "image", data: block.data, mimeType: block.mimeType };
    throw new RequestError(503);
  });
  if (observation)
    content.push({ type: "text", text: JSON.stringify({ observation }) });
  const encoded = JSON.stringify({ content });
  if (Buffer.byteLength(encoded) > 8 * 1024 * 1024) throw new RequestError(503);
  return { status: 200, body: encoded };
}
/** Run-scoped loopback authority; cached outcomes never bypass generation admission. */
export async function startDesktopToolServer({
  desktops,
}: {
  desktops: DesktopService;
}): Promise<DesktopToolServer> {
  const leases = new Map<
    string,
    {
      profileId: string;
      generation: string;
      owner: string;
      tools: Set<string>;
      calls: Map<string, { fingerprint: string; result: Promise<Reply> }>;
      bytes: number;
      pending: number;
      revoked: boolean;
      close(): void;
    }
  >();
  const runIds = new Set<string>();
  let activeLeases = 0;
  let closed = false;
  let shutdown: Promise<void> | undefined;
  const server = createServer((request, res) => {
    void (async () => {
      try {
        if (request.headers.origin !== undefined) throw new RequestError(403);
        if (request.method !== "POST" || request.url !== "/invoke")
          throw new RequestError(404);
        const token = request.headers.authorization?.match(
          /^Bearer ([a-f0-9]{64})$/,
        )?.[1];
        const lease = token ? leases.get(token) : undefined;
        if (!lease || closed) throw new RequestError(401);
        const input = await body(request);
        keys(input, ["tool", "callId", "args"]);
        if (
          !bounded(input.callId) ||
          typeof input.tool !== "string" ||
          !lease.tools.has(input.tool)
        )
          throw new RequestError(400);
        const args = object(input.args),
          tool = input.tool,
          callId = input.callId;
        // Recheck after asynchronous body reads, including before serving cached outcomes.
        if (leases.get(token!) !== lease) throw new RequestError(401);
        try {
          desktops.access(lease.profileId, lease.generation);
        } catch {
          throw new RequestError(409);
        }
        try {
          if (tool === "desktop_capture") {
            keys(args, []);
          } else if (tool === "window_capture") {
            bindWindowRequest(lease.owner, "get_window_state", args);
          } else {
            keys(args, ["observation", "action", "input"]);
            if (!bounded(args.observation) || typeof args.action !== "string")
              throw new RequestError(400);
            const values = object(args.input);
            if (tool === "desktop_input")
              bindDesktopRequest(lease.owner, args.action, values);
            else bindWindowRequest(lease.owner, args.action, values);
            if (["get_window_state", "get_desktop_state"].includes(args.action))
              throw new RequestError(400);
          }
        } catch {
          throw new RequestError(400);
        }
        const fingerprint = createHash("sha256")
          .update(canonical({ tool, args }))
          .digest("hex");
        let call = lease.calls.get(callId);
        if (call && call.fingerprint !== fingerprint)
          throw new RequestError(409);
        if (!call) {
          const reservation = 8 * 1024 * 1024;
          if (
            lease.calls.size >= 256 ||
            lease.bytes + reservation > 16 * 1024 * 1024
          )
            throw new RequestError(429);
          lease.bytes += reservation;
          lease.pending++;
          const result = Promise.resolve()
            .then(async () => {
              try {
                if (lease.revoked || closed) throw new RequestError(401);
                const broker = desktops.access(
                  lease.profileId,
                  lease.generation,
                ).broker;
                if (tool === "desktop_capture") {
                  const value = await broker.captureDesktop(lease.owner);
                  return response(value.result, value.observation);
                }
                if (tool === "window_capture") {
                  const value = await broker.capture(lease.owner, args);
                  return response(value.result, value.observation);
                }
                const result =
                  tool === "desktop_input"
                    ? await broker.desktopInput(
                        lease.owner,
                        args.observation as string,
                        args.action as string,
                        object(args.input),
                      )
                    : await broker.agentInput(
                        lease.owner,
                        args.observation as string,
                        args.action as string,
                        object(args.input),
                      );
                return response(result);
              } catch {
                return {
                  status: 503,
                  body: JSON.stringify({
                    error: "Desktop effect unavailable; do not retry",
                  }),
                };
              }
            })
            .then((reply) => {
              lease.bytes += Buffer.byteLength(reply.body) - reservation;
              lease.pending--;
              if (lease.revoked && lease.pending === 0) activeLeases--;
              return reply;
            });
          call = { fingerprint, result };
          lease.calls.set(callId, call);
        }
        const result = await call.result;
        res.writeHead(result.status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(result.body);
      } catch (error) {
        res.writeHead(error instanceof RequestError ? error.status : 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ error: "Desktop tool request rejected" }));
      }
    })();
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Desktop tool listener unavailable");
  const url = `http://127.0.0.1:${address.port}/invoke`;
  return {
    open(input) {
      if (closed || input.signal.aborted || !bounded(input.runId))
        throw new RequestError(409);
      if (runIds.has(input.runId) || runIds.size >= 10000 || activeLeases >= 64)
        throw new RequestError(429);
      const generation = desktops.get(input.profileId).desktop.generation;
      if (!generation) throw new RequestError(409);
      desktops.access(input.profileId, generation);
      const token = randomBytes(32).toString("hex");
      const tools = [
        ...new Set(
          input.tools.filter((tool) =>
            (DESKTOP_AGENT_TOOLS as readonly string[]).includes(tool),
          ),
        ),
      ];
      const close = () => {
        const lease = leases.get(token);
        if (!lease) return;
        lease.revoked = true;
        if (lease.pending === 0) activeLeases--;
        leases.delete(token);
        input.signal.removeEventListener("abort", close);
      };
      runIds.add(input.runId);
      activeLeases++;
      leases.set(token, {
        bytes: 0,
        pending: 0,
        revoked: false,
        profileId: input.profileId,
        generation,
        owner: `run:${createHash("sha256")
          .update(JSON.stringify([input.profileId, input.runId]))
          .digest("hex")}`,
        tools: new Set(tools),
        calls: new Map(),
        close,
      });
      input.signal.addEventListener("abort", close, { once: true });
      return { url, token, tools, close };
    },
    close() {
      if (shutdown) return shutdown;
      closed = true;
      for (const lease of leases.values()) lease.close();
      server.closeAllConnections();
      shutdown = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      return shutdown;
    },
  };
}
