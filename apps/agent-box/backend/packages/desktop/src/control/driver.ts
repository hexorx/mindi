import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

const PROTOCOL = "2025-06-18";
const MAX_LINE_BYTES = 32 * 1024 * 1024;
type JsonObject = Record<string, unknown>;
interface Transport {
  input: Writable;
  output: Readable;
  lifecycle: EventEmitter;
}
interface Pending {
  resolve: (value: JsonObject) => void;
  reject: (error: Error) => void;
}
function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function contentBlock(value: unknown): boolean {
  if (!object(value)) return false;
  switch (value.type) {
    case "text":
      return typeof value.text === "string";
    case "image":
    case "audio":
      return (
        typeof value.data === "string" && typeof value.mimeType === "string"
      );
    case "resource_link":
      return typeof value.uri === "string" && typeof value.name === "string";
    case "resource":
      return (
        object(value.resource) &&
        typeof value.resource.uri === "string" &&
        (typeof value.resource.text === "string" ||
          typeof value.resource.blob === "string")
      );
    default:
      return false;
  }
}

/**
 * Long-lived MCP stdio connection to the configured driver. Never retries,
 * cancels, or times out commands. Losing a correlated successful response means
 * execution is uncertain; an ownership broker must retain its input permit.
 * No stderr, tool arguments, or response contents are included in errors.
 */
export class DesktopDriver {
  private state: "new" | "starting" | "ready" | "failed" = "new";
  private sequence = 0;
  private buffer = "";
  private pending = new Map<number, Pending>();
  private readonly exited: Promise<void>;
  constructor(private readonly transport: Transport) {
    this.exited = new Promise((resolve) => {
      transport.lifecycle.once("close", () => resolve());
    });
    transport.output.setEncoding("utf8");
    transport.output.on("data", (chunk: string) => this.receive(chunk));
    transport.output.on("end", () => this.fail());
    transport.output.on("error", () => this.fail());
    transport.input.on("error", () => this.fail());
    transport.lifecycle.on("exit", () => this.fail());
    transport.lifecycle.on("error", () => this.fail());
  }
  private fail() {
    this.state = "failed";
    this.buffer = "";
    for (const pending of this.pending.values())
      pending.reject(new Error("Driver unavailable; execution is uncertain."));
    this.pending.clear();
  }
  private write(message: JsonObject) {
    try {
      this.transport.input.write(JSON.stringify(message) + "\n", (error) => {
        if (error) this.fail();
      });
    } catch {
      this.fail();
    }
  }
  private request(method: string, params: JsonObject): Promise<JsonObject> {
    if (this.state === "failed")
      return Promise.reject(
        new Error("Driver unavailable; execution is uncertain."),
      );
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }
  private receive(chunk: string) {
    if (this.state === "failed") return;
    this.buffer += chunk;
    // Bound partial as well as complete frames, before parsing untrusted JSON.
    if (Buffer.byteLength(this.buffer) > MAX_LINE_BYTES) return this.fail();
    let newline: number;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        return this.fail();
      }
      if (!object(message) || message.jsonrpc !== "2.0") return this.fail();
      if ("method" in message) {
        if (typeof message.method !== "string") return this.fail();
        if ("id" in message) {
          if (typeof message.id !== "string" && typeof message.id !== "number")
            return this.fail();
          // Ping is a base protocol operation, not an advertised capability.
          this.write(
            message.method === "ping"
              ? { jsonrpc: "2.0", id: message.id, result: {} }
              : {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32601, message: "Method not supported" },
                },
          );
        }
        continue;
      }
      if (typeof message.id !== "number") return this.fail();
      const pending = this.pending.get(message.id);
      if (!pending) return this.fail();
      this.pending.delete(message.id);
      if ("error" in message || !object(message.result))
        pending.reject(
          new Error("Driver response failed; execution is uncertain."),
        );
      else pending.resolve(message.result);
    }
  }
  async initialize(): Promise<void> {
    if (this.state !== "new")
      throw new Error("Driver initialization already attempted.");
    this.state = "starting";
    try {
      const result = await this.request("initialize", {
        protocolVersion: PROTOCOL,
        capabilities: {},
        clientInfo: { name: "mindi-desktop-control", version: "1" },
      });
      if (
        result.protocolVersion !== PROTOCOL ||
        !object(result.capabilities) ||
        !object(result.capabilities.tools)
      )
        throw new Error("Driver protocol or tool capability is unsupported.");
      if (this.state !== "starting") throw new Error("Driver unavailable.");
      this.state = "ready";
      this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
      if (this.state !== "ready") throw new Error("Driver unavailable.");
    } catch (error) {
      this.fail();
      throw error;
    }
  }
  /** Current initialized transport state; performs no driver calls. */
  isReady(): boolean {
    return this.state === "ready";
  }
  disconnect(): void {
    // Disconnect is not proof that persistent-driver execution has stopped.
    this.fail();
    this.transport.input.end();
  }
  /** Child process and stdio closure only; detached descendants are not covered. */
  waitForExit(): Promise<void> {
    return this.exited;
  }
  async listTools(): Promise<JsonObject> {
    if (this.state !== "ready")
      throw new Error("Driver unavailable or not initialized.");
    return this.request("tools/list", {});
  }
  async call(name: string, args: JsonObject): Promise<JsonObject> {
    if (this.state !== "ready")
      throw new Error("Driver unavailable or not initialized.");
    const result = await this.request("tools/call", { name, arguments: args });
    if (
      ("isError" in result && typeof result.isError !== "boolean") ||
      result.isError === true ||
      !Array.isArray(result.content) ||
      !result.content.every(contentBlock) ||
      ("structuredContent" in result && !object(result.structuredContent))
    )
      throw new Error("Driver tool failed; execution is uncertain.");
    return result;
  }
}

/** Use the pinned runtime's resolved executable/arguments/environment unchanged. */
export function launchDesktopDriver(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) {
  const child = spawn(command, args, {
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  return new DesktopDriver({
    input: child.stdin,
    output: child.stdout,
    lifecycle: child,
  });
}
