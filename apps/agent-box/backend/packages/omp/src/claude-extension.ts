import { permissionAnswer } from "./permission-answer.js";
import { AcpClient, nativeClaudeLaunch, type ConnectOptions } from "@mindi/acp";
import { randomUUID } from "node:crypto";
import { TranscriptStore, type TranscriptEvent } from "@mindi/herdr";
export interface ClaudeExtensionOptions {
  cwd: string;
  transcriptDir: string;
  runId?: string;
  threadId?: string;
  permissionKinds?: readonly string[];
  interactivePermissions?: boolean;
  maxTranscriptBytes?: number;
  /** Trusted host override for integration fixtures, never model input. */
  launch?: Pick<ConnectOptions, "command" | "args" | "env" | "timeoutMs">;
}
interface ToolResult {
  content: { type: "text"; text: string }[];
  details: {
    transport: "ACP";
    phase: "streaming" | "completed";
    transcriptId: string;
    sessionId?: string;
  };
}
interface ExtensionHost {
  zod: {
    string: () => unknown;
    object: (shape: { prompt: unknown }) => unknown;
  };
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    hidden: boolean;
    execute: (
      id: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: (result: ToolResult) => void,
      context?: {
        ui: {
          select(
            title: string,
            options: string[],
            settings?: { signal?: AbortSignal; timeout?: number },
          ): Promise<string | undefined>;
        };
      },
    ) => Promise<ToolResult>;
  }): void;
}
export function createClaudeExtension(
  options: ClaudeExtensionOptions,
): (host: ExtensionHost) => void {
  const limit = options.maxTranscriptBytes ?? 2 * 1024 * 1024;
  if (!Number.isSafeInteger(limit) || limit < 8192)
    throw new Error("Invalid transcript limit");
  const allowed = new Set(options.permissionKinds ?? []);
  return (host) =>
    host.registerTool({
      name: "delegate_claude",
      label: "Delegate to native Claude",
      description:
        "Delegate a coding task to the native Claude harness. Tool permissions follow the operator policy.",
      hidden: true,
      parameters: host.zod.object({ prompt: host.zod.string() }),
      async execute(id, params, signal, onUpdate) {
        if (
          typeof params !== "object" ||
          params === null ||
          !("prompt" in params) ||
          typeof params.prompt !== "string" ||
          !params.prompt.trim() ||
          Buffer.byteLength(params.prompt) > 65536 ||
          id.length > 256
        )
          throw new Error("Invalid Claude delegation prompt");
        if (!options.runId || !options.threadId)
          throw new Error("Missing trusted run association");
        if (signal?.aborted) throw new Error("Claude delegation aborted");
        const store = new TranscriptStore(options.transcriptDir, limit);
        const transcriptId = randomUUID();
        await store.create({
          id: transcriptId,
          runId: options.runId,
          threadId: options.threadId,
          toolCallId: id,
        });
        const failedWrite = new AbortController();
        const childSignal = signal
          ? AbortSignal.any([signal, failedWrite.signal])
          : failedWrite.signal;
        let writeError: unknown;
        let writes = Promise.resolve();
        const append = (event: TranscriptEvent) => {
          writes = writes.then(async () => {
            if (writeError) return;
            try {
              await store.append(transcriptId, event);
            } catch (error) {
              writeError = error;
              failedWrite.abort();
            }
          });
          return writes;
        };
        const cancelled = () => {
          void append({ type: "cancel_requested" });
        };
        signal?.addEventListener("abort", cancelled, { once: true });
        if (signal?.aborted) cancelled();
        let client: AcpClient | undefined;
        try {
          client = await AcpClient.connect({
            ...nativeClaudeLaunch({ cwd: options.cwd }),
            ...options.launch,
            cwd: options.cwd,
            signal: childSignal,
            processGroup: "inherit",
            requestPermission: async (request) => {
              if (options.interactivePermissions) {
                if (childSignal.aborted) return null;
                await append({
                  type: "blocked",
                  message: "Claude tool permission requires operator response",
                });
                const answer = await permissionAnswer(request, childSignal);
                if (!childSignal.aborted) await append({ type: "working" });
                return childSignal.aborted ? null : answer;
              }
              const kind = request.toolCall.kind;
              if (typeof kind !== "string" || !allowed.has(kind)) return null;
              return (
                request.options.find((option) => option.kind === "allow_once")
                  ?.optionId ?? null
              );
            },
            onText: (text) => {
              void append({ type: "text", text });
              onUpdate?.({
                content: [{ type: "text", text }],
                details: { transport: "ACP", phase: "streaming", transcriptId },
              });
            },
          });
          const { sessionId } = await client.newSession({
            cwd: options.cwd,
            mcpServers: [],
          });
          await append({ type: "session", sessionId });
          if (writeError) throw writeError;
          const result = await client.prompt({
            sessionId,
            text: params.prompt,
            signal: childSignal,
          });
          await writes;
          if (writeError) throw writeError;
          await client?.close();
          await writes;
          await store.append(transcriptId, {
            type: signal?.aborted ? "cancelled" : "completed",
          });
          return {
            content: [{ type: "text", text: result.text }],
            details: {
              transport: "ACP",
              phase: "completed",
              sessionId,
              transcriptId,
            },
          };
        } catch {
          await writes;
          await client?.close();
          await writes;
          await store.append(transcriptId, {
            type: signal?.aborted ? "cancelled" : "failed",
          });
          throw new Error(
            signal?.aborted
              ? "Claude delegation cancelled"
              : "Claude delegation failed",
          );
        } finally {
          signal?.removeEventListener("abort", cancelled);
          await client?.close();
        }
      },
    });
}
export default function claudeExtension(host: ExtensionHost): void {
  const cwd = process.env.MINDI_CLAUDE_CWD;
  const transcriptDir = process.env.MINDI_CLAUDE_TRANSCRIPTS;
  if (!cwd || !transcriptDir)
    throw new Error("Missing trusted Claude delegation configuration");
  const permissionKinds: unknown = JSON.parse(
    process.env.MINDI_CLAUDE_PERMISSION_KINDS ?? "[]",
  );
  if (
    !Array.isArray(permissionKinds) ||
    permissionKinds.some((kind) => typeof kind !== "string")
  )
    throw new Error("Invalid Claude permission policy");
  createClaudeExtension({
    cwd,
    transcriptDir,
    permissionKinds,
    interactivePermissions: process.env.MINDI_CLAUDE_INTERACTIVE === "1",
    runId: process.env.MINDI_CLAUDE_RUN_ID,
    threadId: process.env.MINDI_CLAUDE_THREAD_ID,
  })(host);
}
