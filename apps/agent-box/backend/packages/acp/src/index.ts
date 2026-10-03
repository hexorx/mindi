import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
export interface PermissionRequest {
  sessionId: string;
  toolCall: Readonly<Record<string, unknown>> & { toolCallId: string };
  options: readonly {
    optionId: string;
    name: string;
    kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  }[];
}
export interface ConnectOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxFrameBytes?: number;
  signal?: AbortSignal;
  processGroup?: "isolated" | "inherit";
  onText?: (text: string) => void;
  requestPermission?: (request: PermissionRequest) => Promise<string | null>;
}
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid ACP object");
  return value as ObjectValue;
}
function validateContent(value: unknown): ObjectValue {
  const content = object(value);
  const validString = (key: string) => typeof content[key] === "string";
  switch (content.type) {
    case "text":
      if (!validString("text")) throw new Error("Invalid ACP text content");
      break;
    case "image":
    case "audio":
      if (!validString("data") || !validString("mimeType"))
        throw new Error("Invalid ACP media content");
      break;
    case "resource_link":
      if (!validString("uri") || !validString("name"))
        throw new Error("Invalid ACP resource link content");
      break;
    case "resource": {
      const resource = object(content.resource);
      if (
        typeof resource.uri !== "string" ||
        (typeof resource.text !== "string" &&
          typeof resource.blob !== "string") ||
        (resource.mimeType !== undefined &&
          typeof resource.mimeType !== "string")
      )
        throw new Error("Invalid ACP resource content");
      break;
    }
    default:
      throw new Error("Invalid or unsupported ACP content type");
  }
  return content;
}
export class AcpClient {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private prompts = new Map<string, { text: string; cancelled: boolean }>();
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private closed: Promise<void>;
  private failure?: Error;
  private closing?: Promise<void>;
  private processGroupCleaned = false;
  private buffer = Buffer.alloc(0);
  private constructor(private options: ConnectOptions) {
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      detached:
        process.platform !== "win32" && options.processGroup !== "inherit",
    });
    const abort = () => {
      if (!this.failure)
        for (const [sessionId, prompt] of this.prompts) {
          prompt.cancelled = true;
          this.send({ method: "session/cancel", params: { sessionId } });
        }
      this.fail(new Error("ACP connection aborted"));
      void this.close();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    this.closed = new Promise((resolve) =>
      this.child.once("close", () => {
        options.signal?.removeEventListener("abort", abort);
        this.fail(new Error("ACP process closed"));
        resolve();
      }),
    );
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", () => {});
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        let newline: number;
        while ((newline = this.buffer.indexOf(10)) >= 0) {
          if (newline > this.frameLimit)
            throw new Error("ACP frame exceeds limit");
          const frame = object(
            JSON.parse(this.buffer.subarray(0, newline).toString("utf8")),
          );
          this.buffer = this.buffer.subarray(newline + 1);
          if (frame.jsonrpc !== "2.0")
            throw new Error("Invalid ACP JSON-RPC version");
          if ("method" in frame) {
            if (
              typeof frame.method !== "string" ||
              "result" in frame ||
              "error" in frame
            )
              throw new Error("Invalid ACP envelope");
          } else {
            if (
              (typeof frame.id !== "number" && typeof frame.id !== "string") ||
              "result" in frame === "error" in frame
            )
              throw new Error("Invalid ACP envelope");
            if ("error" in frame) {
              const error = object(frame.error);
              if (
                typeof error.code !== "number" ||
                typeof error.message !== "string"
              )
                throw new Error("Invalid ACP error");
            }
          }
          if (typeof frame.method === "string" && frame.id !== undefined) {
            void this.handleRequest(frame).catch((error) => {
              this.fail(
                error instanceof Error ? error : new Error(String(error)),
              );
              void this.close();
            });
            continue;
          }
          if (frame.method === "session/update") {
            const params = object(frame.params);
            const update = object(params.update);
            if (typeof params.sessionId !== "string")
              throw new Error("Invalid update session");
            if (update.sessionUpdate === "agent_message_chunk") {
              const content = validateContent(update.content);
              if (content.type === "text") {
                if (typeof content.text !== "string")
                  throw new Error("Invalid text chunk");
                const prompt = this.prompts.get(params.sessionId);
                if (prompt) {
                  if (
                    Buffer.byteLength(prompt.text) +
                      Buffer.byteLength(content.text) >
                    this.frameLimit
                  )
                    throw new Error("ACP output exceeds limit");
                  prompt.text += content.text;
                  this.options.onText?.(content.text);
                }
              }
            }
          }
          if (typeof frame.id === "number") {
            const pending = this.pending.get(frame.id);
            if (pending) {
              this.pending.delete(frame.id);
              if (frame.error) pending.reject(new Error("ACP request failed"));
              else pending.resolve(frame.result);
            }
          }
        }
        if (this.buffer.length > this.frameLimit)
          throw new Error("ACP frame exceeds limit");
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        void this.close();
      }
    });
  }
  static async connect(options: ConnectOptions): Promise<AcpClient> {
    if (options.signal?.aborted) throw new Error("ACP connection aborted");
    if (
      !Number.isSafeInteger(options.timeoutMs ?? 150000) ||
      (options.timeoutMs ?? 150000) <= 0 ||
      !Number.isSafeInteger(options.maxFrameBytes ?? 1048576) ||
      (options.maxFrameBytes ?? 1048576) <= 0
    )
      throw new Error("Invalid ACP limits");
    const client = new AcpClient(options);
    try {
      const result = object(
        await client.request("initialize", {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "mindi-acp", version: "0.0.0" },
        }),
      );
      if (result.protocolVersion !== 1)
        throw new Error("Unsupported ACP protocol version");
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }
  private get frameLimit() {
    return this.options.maxFrameBytes ?? 1024 * 1024;
  }
  private async handleRequest(frame: ObjectValue): Promise<void> {
    if (typeof frame.id !== "number" && typeof frame.id !== "string")
      throw new Error("Invalid ACP request id");
    if (frame.method !== "session/request_permission") {
      this.send({
        id: frame.id,
        error: { code: -32601, message: "Client capability unavailable" },
      });
      return;
    }
    const params = object(frame.params);
    const toolCall = object(params.toolCall);
    if (
      typeof params.sessionId !== "string" ||
      typeof toolCall.toolCallId !== "string" ||
      !Array.isArray(params.options)
    )
      throw new Error("Invalid permission request");
    const options = params.options.map(
      (value: unknown): PermissionRequest["options"][number] => {
        const option = object(value);
        if (
          typeof option.optionId !== "string" ||
          typeof option.name !== "string" ||
          (option.kind !== "allow_once" &&
            option.kind !== "allow_always" &&
            option.kind !== "reject_once" &&
            option.kind !== "reject_always")
        )
          throw new Error("Invalid permission option");
        return {
          optionId: option.optionId,
          name: option.name,
          kind: option.kind,
        };
      },
    );
    const request: PermissionRequest = {
      sessionId: params.sessionId,
      toolCall: { ...toolCall, toolCallId: toolCall.toolCallId },
      options,
    };
    const prompt = this.prompts.get(params.sessionId);
    const offeredIds = new Set(options.map((option) => option.optionId));
    const choice =
      prompt && !prompt.cancelled
        ? await this.options.requestPermission?.(request)
        : null;
    if (this.failure) return;
    this.send({
      id: frame.id,
      result: {
        outcome:
          choice &&
          prompt &&
          !prompt.cancelled &&
          this.prompts.get(params.sessionId) === prompt &&
          offeredIds.has(choice)
            ? { outcome: "selected", optionId: choice }
            : { outcome: "cancelled" },
      },
    });
  }
  private fail(error: Error) {
    this.failure ??= error;
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }
  private send(frame: ObjectValue) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
  }
  private request(method: string, params: ObjectValue): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (method === "session/prompt")
          this.send({
            method: "session/cancel",
            params: { sessionId: params.sessionId },
          });
        this.fail(new Error("ACP timeout"));
        void this.close();
      }, this.options.timeoutMs ?? 150000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ id, method, params });
    });
  }
  async newSession(params: {
    cwd: string;
    mcpServers: [];
  }): Promise<{ sessionId: string }> {
    const result = object(await this.request("session/new", params));
    if (typeof result.sessionId !== "string" || !result.sessionId)
      throw new Error("Invalid ACP session");
    return { sessionId: result.sessionId };
  }
  async prompt(params: {
    sessionId: string;
    text: string;
    signal?: AbortSignal;
  }): Promise<{ text: string; stopReason: string }> {
    if (params.signal?.aborted) throw new Error("ACP prompt aborted");
    if (this.prompts.has(params.sessionId))
      throw new Error("ACP session already has an active prompt");
    const state = { text: "", cancelled: false };
    this.prompts.set(params.sessionId, state);
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      state.cancelled = true;
      if (this.failure) return;
      this.send({
        method: "session/cancel",
        params: { sessionId: params.sessionId },
      });
      abortTimer = setTimeout(() => {
        this.fail(new Error("ACP prompt aborted"));
        void this.close();
      }, 250);
    };
    params.signal?.addEventListener("abort", abort, { once: true });
    try {
      const result = object(
        await this.request("session/prompt", {
          sessionId: params.sessionId,
          prompt: [{ type: "text", text: params.text }],
        }),
      );
      if (params.signal?.aborted) throw new Error("ACP prompt aborted");
      if (result.stopReason !== "end_turn" || !state.text.trim())
        throw new Error("ACP prompt did not complete with text");
      return { text: state.text, stopReason: result.stopReason };
    } catch (error) {
      if (params.signal?.aborted) throw new Error("ACP prompt aborted");
      throw error;
    } finally {
      state.cancelled = true;
      clearTimeout(abortTimer);
      params.signal?.removeEventListener("abort", abort);
      this.prompts.delete(params.sessionId);
    }
  }
  private killOwnedProcess(): void {
    if (this.processGroupCleaned) return;
    this.processGroupCleaned = true;
    try {
      if (
        process.platform !== "win32" &&
        this.child.pid &&
        this.options.processGroup !== "inherit"
      )
        process.kill(-this.child.pid, "SIGKILL");
      else this.child.kill("SIGKILL");
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ))
        throw error;
    }
  }
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }
  private async shutdown(): Promise<void> {
    this.fail(new Error("ACP client closed"));
    this.child.stdin.end();
    const timer = setTimeout(() => {
      this.killOwnedProcess();
      if (this.options.processGroup === "inherit") {
        this.child.stdin.destroy();
        this.child.stdout.destroy();
        this.child.stderr.destroy();
      }
    }, 250);
    try {
      await this.closed;
      // The launcher may exit while unreferenced descendants keep running.
      // Clean its dedicated group before relinquishing ownership.
      this.killOwnedProcess();
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Use the adapter's native Claude login without reading or copying credentials. */
export function nativeClaudeLaunch(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): ConnectOptions {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (
      /^(ANTHROPIC_|CLAUDE_CODE_|AWS_BEARER_TOKEN_BEDROCK$)/.test(key) ||
      key === "MINDI_CLAUDE_PERMISSION_URL" ||
      key === "MINDI_CLAUDE_PERMISSION_TOKEN"
    )
      continue;
    env[key] = value;
  }
  return {
    command: env.MINDI_CLAUDE_ACP_COMMAND || "npx",
    args: env.MINDI_CLAUDE_ACP_COMMAND
      ? []
      : ["--yes", "@agentclientprotocol/claude-agent-acp@0.75.1"],
    cwd: options.cwd,
    env,
  };
}
