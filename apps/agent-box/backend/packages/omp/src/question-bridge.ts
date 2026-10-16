import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import {
  validateInteractionRequest,
  validateInteractionResponse,
  type InteractionRequest,
  type InteractionResponse,
  type WorkerInput,
} from "@mindi/agent-runtime";

export interface InteractionBridge {
  url: string;
  token: string;
  close(): Promise<void>;
}
type Result = { status: number; body: InteractionResponse | { error: string } };
type Call = {
  fingerprint: string;
  controller: AbortController;
  result: Promise<Result>;
};
class BoundaryError extends Error {
  constructor(readonly status: number) {
    super("Invalid question bridge request");
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
function readBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const timer = setTimeout(() => finish(new BoundaryError(408)), 10000);
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("error", failed);
      if (error) reject(error);
      else resolve(value);
    };
    const failed = () => finish(new BoundaryError(400));
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > 65536) {
        finish(new BoundaryError(413));
        request.resume();
      } else chunks.push(chunk);
    };
    const end = () => {
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        failed();
      }
    };
    request.on("data", data);
    request.once("end", end);
    request.once("error", failed);
  });
}

type BridgeInput = {
  requestInteraction: NonNullable<WorkerInput["requestInteraction"]>;
  signal: AbortSignal;
};
export function openQuestionBridge(
  input: BridgeInput,
): Promise<InteractionBridge> {
  return openInteractionBridge(input, "question");
}
export function openPermissionBridge(
  input: BridgeInput,
): Promise<InteractionBridge> {
  return openInteractionBridge(input, "permission");
}
/** Separate short-lived capabilities for one worker run, never model-visible. */
async function openInteractionBridge(
  input: BridgeInput,
  channel: "question" | "permission",
): Promise<InteractionBridge> {
  if (input.signal.aborted) throw new Error("Question bridge cancelled");
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Bearer ${token}`);
  const calls = new Map<string, Call>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const server = createServer(async (request, response) => {
    const send = (result: Result) => {
      if (!response.destroyed && !response.writableEnded) {
        response.writeHead(result.status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        });
        response.end(JSON.stringify(result.body));
      }
    };
    const error = (status: number, code: string) =>
      send({ status, body: { error: code } });
    if (closed) return error(410, "closed");
    const supplied = Buffer.from(request.headers.authorization ?? "");
    if (
      supplied.length !== authorization.length ||
      !timingSafeEqual(supplied, authorization)
    )
      return error(401, "unauthorized");
    if (request.url !== `/${channel}`) return error(404, "not_found");
    if (request.method !== "POST") return error(405, "method_not_allowed");
    let call: Call | undefined;
    const disconnected = () => {
      if (!response.writableEnded) call?.controller.abort();
    };
    response.once("close", disconnected);
    try {
      const body = await readBody(request);
      if (closed || response.destroyed) return;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !Object.hasOwn(body, "callId") ||
        !Object.hasOwn(body, "request")
      )
        throw new BoundaryError(400);
      const { callId, request: interaction } = body as {
        callId: unknown;
        request: InteractionRequest;
      };
      if (
        typeof callId !== "string" ||
        !callId.trim() ||
        Buffer.byteLength(callId) > 128
      )
        throw new BoundaryError(400);
      try {
        validateInteractionRequest(interaction);
        if (
          (channel === "permission"
            ? interaction.kind !== "choice"
            : interaction.kind !== "question" && interaction.kind !== "text") ||
          Object.hasOwn(interaction, "source")
        )
          throw new Error();
      } catch {
        throw new BoundaryError(400);
      }
      const fingerprint = canonical(interaction);
      call = calls.get(callId);
      if (call && call.fingerprint !== fingerprint)
        return error(409, "call_conflict");
      if (!call) {
        if (calls.size >= 32) return error(429, "call_limit");
        const controller = new AbortController();
        let cancel!: () => void;
        const cancelled = new Promise<Result>((resolve) => {
          cancel = () => resolve({ status: 200, body: { cancelled: true } });
        });
        controller.signal.addEventListener("abort", cancel, { once: true });
        const timer = setTimeout(
          () => controller.abort(),
          interaction.timeoutMs ?? 120000,
        );
        const result = Promise.race([
          cancelled,
          Promise.resolve()
            .then(() =>
              input.requestInteraction(
                {
                  ...interaction,
                  source:
                    channel === "permission"
                      ? "acp-permission"
                      : "omp-question",
                },
                controller.signal,
              ),
            )
            .then((answer): Result => {
              validateInteractionResponse(interaction, answer);
              return { status: 200, body: answer };
            })
            .catch((): Result => ({
              status: 500,
              body: { error: "interaction_failed" },
            })),
        ]).finally(() => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", cancel);
        });
        call = { fingerprint, controller, result };
        calls.set(callId, call);
      }
      send(await call.result);
    } catch (cause) {
      error(
        cause instanceof BoundaryError ? cause.status : 500,
        "invalid_request",
      );
    } finally {
      response.off("close", disconnected);
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxConnections = 64;
  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    input.signal.removeEventListener("abort", aborted);
    for (const call of calls.values()) call.controller.abort();
    closing = new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    return closing;
  }
  const aborted = () => {
    void close();
  };
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new Error("Question bridge unavailable"));
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", failed);
      resolve();
    });
  });
  input.signal.addEventListener("abort", aborted, { once: true });
  if (input.signal.aborted) {
    await close();
    throw new Error("Question bridge cancelled");
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await close();
    throw new Error("Question bridge unavailable");
  }
  return { url: `http://127.0.0.1:${address.port}/${channel}`, token, close };
}
