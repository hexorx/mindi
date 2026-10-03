import { openQuestionBridge, openPermissionBridge } from "./question-bridge.js";
import { conversationOutputResult } from "./conversation-result-extension.js";
import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  realpath,
  stat,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve, relative, isAbsolute } from "node:path";
import type {
  AgentWorker,
  AgentProfile,
  WorkerInput,
  WorkerEvent,
  BranchPoint,
} from "@mindi/agent-runtime";
import { RuntimeError } from "@mindi/agent-runtime";
import { OmpProcess, object } from "./protocol.js";
import { taskOutcomeResult } from "./task-result-extension.js";
import { AGENT_TOOLS, type AgentToolLease } from "@mindi/agent-tools";
import { DESKTOP_AGENT_TOOLS, type DesktopToolLease } from "@mindi/desktop";
import { prepareAttachments, type PdfTools } from "./attachments.js";
async function disposeAll(
  disposers: (() => unknown)[],
  priorityError: unknown,
) {
  let disposalError: unknown;
  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      disposalError ??= error;
    }
  }
  // Uncertain process ownership must survive a later lease/filesystem error.
  if (priorityError) throw priorityError;
  if (disposalError) throw disposalError;
}
export interface OmpWorkerOptions {
  pdfTools?: PdfTools;
  openDesktopTools?: (input: {
    runId: string;
    profile: AgentProfile;
    signal: AbortSignal;
  }) => DesktopToolLease;
  openAgentTools?: (input: {
    runId: string;
    profile: AgentProfile;
    signal: AbortSignal;
  }) => AgentToolLease;
  command?: string;
  args?: string[];
  cwd: string;
  stateRoot: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxFrameBytes?: number;
  onDiagnostic?: (text: string) => void;
  claude?: {
    permissionKinds?: readonly string[];
    interactivePermissions?: boolean;
  };
}
export class OmpWorker implements AgentWorker {
  constructor(private options: OmpWorkerOptions) {
    if (
      !Number.isSafeInteger(options.timeoutMs ?? 150000) ||
      (options.timeoutMs ?? 150000) <= 0 ||
      !Number.isSafeInteger(options.maxFrameBytes ?? 1048576) ||
      (options.maxFrameBytes ?? 1048576) <= 0
    )
      throw new RuntimeError("invalid", "Invalid OMP limits");
  }
  private async sessionPath(path: string): Promise<string> {
    try {
      const root = await realpath(
        join(resolve(this.options.stateRoot), "sessions"),
      );
      const canonical = await realpath(path);
      const suffix = relative(root, canonical);
      if (
        suffix.startsWith("..") ||
        isAbsolute(suffix) ||
        !canonical.endsWith(".jsonl") ||
        !(await stat(canonical)).isFile()
      )
        throw new RuntimeError(
          "invalid",
          "OMP session outside configured state root",
        );
      return canonical;
    } catch {
      throw new RuntimeError(
        "invalid",
        "OMP session path unavailable or outside state root",
      );
    }
  }
  private async withProcess<T>(
    profile: AgentProfile,
    sessionPath: string | undefined,
    signal: AbortSignal,
    emit: ((event: WorkerEvent) => void) | undefined,
    fn: (process: OmpProcess) => Promise<T>,
    context?: {
      runId: string;
      threadId: string;
      requestInteraction?: WorkerInput["requestInteraction"];
      task?: WorkerInput["task"];
      conversation?: WorkerInput["conversation"];
      hasAttachments?: boolean;
      outputDirectory?: string;
    },
  ): Promise<T> {
    if (
      profile.approvalMode !== undefined &&
      !["always-ask", "write", "yolo"].includes(profile.approvalMode)
    )
      throw new RuntimeError("invalid", "Invalid OMP approval mode");
    if (profile.tools?.some((tool) => !/^[_a-zA-Z][_a-zA-Z0-9]*$/.test(tool)))
      throw new RuntimeError("invalid", "Invalid OMP tool allowlist");
    if (profile.tools?.includes("delegate_claude") && !this.options.claude)
      throw new RuntimeError(
        "invalid",
        "Claude delegation requires trusted policy",
      );
    if (
      profile.tools?.some((tool) =>
        ["task_result", "conversation_result"].includes(tool),
      )
    )
      throw new RuntimeError(
        "invalid",
        "task_result/conversation_result require trusted runtime context, not profile configuration",
      );
    const agentTools = (profile.tools ?? []).filter((tool) =>
      (AGENT_TOOLS as readonly string[]).includes(tool),
    );
    if (context && agentTools.length && !this.options.openAgentTools)
      throw new RuntimeError("unavailable", "Task tool service is unavailable");
    const desktopTools = (profile.tools ?? []).filter((tool) =>
      (DESKTOP_AGENT_TOOLS as readonly string[]).includes(tool),
    );
    if (context && desktopTools.length && !this.options.openDesktopTools)
      throw new RuntimeError(
        "unavailable",
        "Desktop tool service is unavailable",
      );
    const allowedTools = [
      ...(profile.tools ?? []).filter(
        (tool) =>
          context ||
          (!agentTools.includes(tool) && !desktopTools.includes(tool)),
      ),
      ...(context?.task ? ["task_result"] : []),
      ...(context?.conversation && context.outputDirectory
        ? ["conversation_result"]
        : []),
    ];
    if (signal.aborted)
      throw new RuntimeError("cancelled", "OMP cancelled before start");
    const sessionDir = join(resolve(this.options.stateRoot), "sessions");
    await mkdir(sessionDir, { recursive: true });
    const resume = sessionPath
      ? await this.sessionPath(sessionPath)
      : undefined;
    const configDir = await mkdtemp(
      join(resolve(this.options.stateRoot), "config-"),
    );
    let agentLease: AgentToolLease | undefined;
    let desktopLease: DesktopToolLease | undefined;
    let questionBridge:
      Awaited<ReturnType<typeof openQuestionBridge>> | undefined;
    let permissionBridge:
      Awaited<ReturnType<typeof openPermissionBridge>> | undefined;
    let cleanupUncertain: unknown;
    try {
      const configPath = join(configDir, "settings.yml");
      await writeFile(
        configPath,
        JSON.stringify({
          memory: { backend: profile.memory ? "hindsight" : "off" },
          hindsight: {
            apiToken: "",
            autoRecall: true,
            autoRetain: false,
            retainEveryNTurns: 1,
            mentalModelsEnabled: false,
            mentalModelAutoSeed: false,
          },
          advisor: { enabled: false },
          mcp: { enableProjectConfig: false },
          // OMP 18.1.13 deep-merges maps: null replaces inherited tool overrides.
          tools: {
            approvalMode: profile.approvalMode ?? "always-ask",
            approval: null,
          },
        }),
        { mode: 0o600 },
      );
      const env = Object.fromEntries(
        Object.entries(this.options.env ?? globalThis.process.env).filter(
          ([key]) =>
            key !== "MINDI_BACKEND_TOKEN" &&
            key !== "MINDI_BACKEND_TOKEN_FILE" &&
            ![
              "DISPLAY",
              "WAYLAND_DISPLAY",
              "SWAYSOCK",
              "XDG_RUNTIME_DIR",
              "DBUS_SESSION_BUS_ADDRESS",
              "HERMES_HOME",
              "MINDI_CHROME_USER_DATA_DIR",
            ].includes(key) &&
            !key.startsWith("MINDI_QUESTION_") &&
            !key.startsWith("MINDI_DESKTOP_") &&
            !key.startsWith("HINDSIGHT_") &&
            !key.startsWith("MINDI_CLAUDE_") &&
            !key.startsWith("MINDI_AGENT_TOOLS_") &&
            !key.startsWith("MINDI_TASK_TOOLS_") &&
            !key.startsWith("MINDI_TASK_OUTPUT_") &&
            !key.startsWith("MINDI_CONVERSATION_OUTPUT_"),
        ),
      );
      if (context?.outputDirectory !== undefined) {
        const directory = context.outputDirectory;
        if (
          !!context.task === !!context.conversation ||
          typeof directory !== "string" ||
          !isAbsolute(directory) ||
          resolve(directory) !== directory ||
          directory.length > 4096 ||
          Array.from(directory).some(
            (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
          )
        )
          throw new RuntimeError("invalid", "Invalid task output context");
        if (context.task) env.MINDI_TASK_OUTPUT_DIRECTORY = directory;
        else env.MINDI_CONVERSATION_OUTPUT_DIRECTORY = directory;
      }
      if (context && agentTools.length) {
        agentLease = this.options.openAgentTools!({
          runId: context.runId,
          profile,
          signal,
        });
        if (
          agentLease.tools.length !== agentTools.length ||
          agentLease.tools.some((tool) => !agentTools.includes(tool))
        )
          throw new RuntimeError(
            "unavailable",
            "Task tool grants do not match profile",
          );
        env.MINDI_AGENT_TOOLS_URL = agentLease.url;
        env.MINDI_AGENT_TOOLS_TOKEN = agentLease.token;
        env.MINDI_AGENT_TOOLS_GRANTS = JSON.stringify(agentLease.tools);
      }
      if (context && desktopTools.length) {
        desktopLease = this.options.openDesktopTools!({
          runId: context.runId,
          profile,
          signal,
        });
        if (
          desktopLease.tools.length !== desktopTools.length ||
          desktopLease.tools.some((tool) => !desktopTools.includes(tool))
        )
          throw new RuntimeError(
            "unavailable",
            "Desktop tool grants do not match profile",
          );
        env.MINDI_DESKTOP_TOOLS_URL = desktopLease.url;
        env.MINDI_DESKTOP_TOOLS_TOKEN = desktopLease.token;
        env.MINDI_DESKTOP_TOOLS_GRANTS = JSON.stringify(desktopLease.tools);
      }
      if (profile.tools?.includes("ask_user") && context?.requestInteraction) {
        questionBridge = await openQuestionBridge({
          requestInteraction: context.requestInteraction,
          signal,
        });
        env.MINDI_QUESTION_URL = questionBridge.url;
        env.MINDI_QUESTION_TOKEN = questionBridge.token;
      }
      if (profile.memory) {
        env.HINDSIGHT_API_URL = profile.memory.url;
        env.HINDSIGHT_BANK_ID = profile.memory.bankId;
        env.HINDSIGHT_SCOPING = "global";
      }
      const delegate = profile.tools?.includes("delegate_claude") ?? false;
      if (delegate) {
        if (
          this.options.claude?.interactivePermissions &&
          context?.requestInteraction
        ) {
          permissionBridge = await openPermissionBridge({
            requestInteraction: context.requestInteraction,
            signal,
          });
          env.MINDI_CLAUDE_PERMISSION_URL = permissionBridge.url;
          env.MINDI_CLAUDE_PERMISSION_TOKEN = permissionBridge.token;
        }
        const command = (this.options.env ?? globalThis.process.env)
          .MINDI_CLAUDE_ACP_COMMAND;
        if (command) env.MINDI_CLAUDE_ACP_COMMAND = command;
        env.MINDI_CLAUDE_INTERACTIVE = this.options.claude
          ?.interactivePermissions
          ? "1"
          : "0";
        env.MINDI_CLAUDE_CWD = this.options.cwd;
        if (context) {
          env.MINDI_CLAUDE_RUN_ID = context.runId;
          env.MINDI_CLAUDE_THREAD_ID = context.threadId;
        }
        env.MINDI_CLAUDE_TRANSCRIPTS = join(
          resolve(this.options.stateRoot),
          "transcripts",
        );
        env.MINDI_CLAUDE_PERMISSION_KINDS = JSON.stringify(
          this.options.claude?.permissionKinds ?? [],
        );
      }
      const process = new OmpProcess(
        this.options.command ?? "omp",
        [
          ...(this.options.args ?? []),
          "--mode",
          "rpc",
          "--cwd",
          this.options.cwd,
          "--session-dir",
          sessionDir,
          ...(allowedTools.length
            ? ["--tools", allowedTools.join(",")]
            : ["--no-tools"]),
          "--approval-mode",
          profile.approvalMode ?? "always-ask",
          "--no-extensions",
          ...(desktopLease
            ? [
                "--extension",
                fileURLToPath(
                  new URL("./desktop-extension.js", import.meta.url),
                ),
              ]
            : []),
          ...(agentLease
            ? [
                "--extension",
                fileURLToPath(
                  new URL("./agent-tools-extension.js", import.meta.url),
                ),
              ]
            : []),
          ...(delegate
            ? [
                "--extension",
                fileURLToPath(
                  new URL("./claude-extension.js", import.meta.url),
                ),
              ]
            : []),
          ...(profile.tools?.includes("ask_user")
            ? [
                "--extension",
                fileURLToPath(
                  new URL("./question-extension.js", import.meta.url),
                ),
              ]
            : []),
          ...(context?.task
            ? [
                "--extension",
                fileURLToPath(
                  new URL("./task-result-extension.js", import.meta.url),
                ),
              ]
            : []),
          ...(context?.conversation && context.outputDirectory
            ? [
                "--extension",
                fileURLToPath(
                  new URL(
                    "./conversation-result-extension.js",
                    import.meta.url,
                  ),
                ),
              ]
            : []),
          "--no-skills",
          "--no-rules",
          "--no-lsp",
          "--no-title",
          "--system-prompt",
          profile.instructions,
          "--config",
          configPath,
          ...(resume ? ["--resume", resume] : []),
        ],
        this.options.cwd,
        env,
        this.options.timeoutMs ?? 150000,
        // Desktop agent_end frames include accumulated image tool results.
        // Keep their bounded transport budget separate from the text ceiling.
        this.options.maxFrameBytes ??
          (desktopLease || context?.hasAttachments
            ? 32 * 1024 * 1024
            : 1048576),
        this.options.onDiagnostic,
        context?.requestInteraction,
      );
      const abort = () => process.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) abort();
        if (process.pid)
          emit?.({
            type: "worker_started",
            pid: process.pid,
            ownership: process.ownership,
          });
        await process.start();
        const ready = await process.ready;
        if (
          ready.protocolVersion !== 1 ||
          !Array.isArray(ready.supportedProtocolVersions) ||
          !ready.supportedProtocolVersions.includes(2)
        )
          throw new RuntimeError("unavailable", "Unsupported OMP protocol");
        const negotiated = object(
          (await process.request("negotiate_protocol", { protocolVersion: 2 }))
            .data,
        );
        if (negotiated.protocolVersion !== 2)
          throw new RuntimeError("unavailable", "OMP negotiation failed");
        await process.request("set_auto_retry", { enabled: false });
        return await fn(process);
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError("unavailable", "OMP worker failed");
      } finally {
        signal.removeEventListener("abort", abort);
        await process.close().catch((error) => {
          cleanupUncertain = error;
          throw error;
        });
      }
    } finally {
      await disposeAll(
        [
          () => questionBridge?.close(),
          () => permissionBridge?.close(),
          () => desktopLease?.close(),
          () => agentLease?.close(),
          () => rm(configDir, { recursive: true, force: true }),
        ],
        cleanupUncertain,
      );
    }
  }
  private async state(process: OmpProcess): Promise<{ sessionPath: string }> {
    const state = object((await process.request("get_state")).data);
    if (typeof state.sessionFile !== "string")
      throw new RuntimeError("unavailable", "OMP session file missing");
    return { sessionPath: await this.sessionPath(state.sessionFile) };
  }
  async run(
    input: WorkerInput,
    emit: (event: WorkerEvent) => void,
  ): Promise<{ sessionPath: string; userEntryId?: string }> {
    const outputDirectory = input.outputDirectory;
    const slash = input.modelId.indexOf("/");
    if (
      slash < 1 ||
      slash === input.modelId.length - 1 ||
      !input.profile.modelIds.includes(input.modelId)
    )
      throw new RuntimeError("invalid", "Invalid OMP model");
    const attachments = await prepareAttachments(
      input.attachments,
      this.options.stateRoot,
      input.signal,
      this.options.timeoutMs ?? 150000,
      this.options.pdfTools,
    );
    return this.withProcess(
      input.profile,
      input.sessionPath,
      input.signal,
      emit,
      async (process) => {
        await process.request("set_model", {
          provider: input.modelId.slice(0, slash),
          modelId: input.modelId.slice(slash + 1),
        });
        const before = await this.entryIds(process);
        let finalText = "";
        let streamedBytes = 0;
        let assistantCompleted = false;
        let taskCallId: string | undefined;
        let taskReported = false;
        let conversationCallId: string | undefined;
        let conversationReported = false;
        const completed = process.wait((frame) => {
          if (frame.type === "message_update") {
            const event = object(frame.assistantMessageEvent);
            if (typeof event.type !== "string")
              throw new Error("Invalid OMP assistant event");
            if (event.type === "text_delta") {
              if (typeof event.delta !== "string")
                throw new Error("Invalid OMP delta");
              streamedBytes += Buffer.byteLength(event.delta);
              if (streamedBytes > (this.options.maxFrameBytes ?? 1048576))
                throw new Error("OMP output exceeds limit");
              emit({ type: "text", text: event.delta });
            }
          }
          if (frame.type === "message_end") {
            const message = object(frame.message);
            if (message.role === "assistant") {
              if (
                message.stopReason !== "stop" &&
                message.stopReason !== "toolUse"
              )
                throw new Error("OMP assistant did not complete");
              assistantCompleted = message.stopReason === "stop";
              if (!Array.isArray(message.content))
                throw new Error("Invalid OMP content");
              finalText = message.content
                .map((value: unknown) => {
                  const part = object(value);
                  if (part.type === "text") {
                    if (typeof part.text !== "string")
                      throw new Error("Invalid OMP text");
                    return part.text;
                  }
                  if (part.type === "thinking") {
                    if (typeof part.thinking !== "string")
                      throw new Error("Invalid OMP thinking");
                    return "";
                  }
                  if (part.type === "toolCall") {
                    if (
                      typeof part.id !== "string" ||
                      typeof part.name !== "string"
                    )
                      throw new Error("Invalid OMP tool call");
                    object(part.arguments);
                    return "";
                  }
                  throw new Error("Invalid OMP assistant content");
                })
                .join("");
              if (
                Buffer.byteLength(finalText) >
                (this.options.maxFrameBytes ?? 1048576)
              )
                throw new Error("OMP output exceeds limit");
            }
          }
          if (
            frame.type === "tool_execution_start" ||
            frame.type === "tool_execution_end"
          ) {
            if (
              typeof frame.toolName !== "string" ||
              typeof frame.toolCallId !== "string" ||
              !(
                input.profile.tools?.includes(frame.toolName) ||
                (input.task && frame.toolName === "task_result") ||
                (input.conversation &&
                  outputDirectory &&
                  frame.toolName === "conversation_result")
              )
            )
              throw new Error("Unexpected OMP tool");
            if (
              frame.type === "tool_execution_end" &&
              typeof frame.isError !== "boolean"
            )
              throw new Error("Invalid OMP tool result");
            if (
              frame.type === "tool_execution_end" &&
              ["delegate_claude", "ask_user"].includes(frame.toolName) &&
              frame.isError
            )
              throw new Error("Claude child failed");
            if (frame.toolName === "conversation_result") {
              if (!frame.toolCallId || conversationReported)
                throw Error("Duplicate or invalid conversation output report");
              if (frame.type === "tool_execution_start") {
                if (conversationCallId !== undefined)
                  throw Error("Duplicate conversation output report");
                conversationCallId = frame.toolCallId;
              } else {
                if (conversationCallId !== frame.toolCallId || frame.isError)
                  throw Error("Failed or unmatched conversation output report");
                const report = conversationOutputResult(frame.result);
                conversationReported = true;
                emit({ type: "conversation_output", ...report });
              }
            }
            if (frame.toolName === "task_result") {
              if (!frame.toolCallId || taskReported)
                throw new Error("Duplicate or invalid task report");
              if (frame.type === "tool_execution_start") {
                if (taskCallId !== undefined)
                  throw new Error("Duplicate task report");
                taskCallId = frame.toolCallId;
              } else {
                if (taskCallId !== frame.toolCallId || frame.isError)
                  throw new Error("Failed or unmatched task report");
                const report = taskOutcomeResult(
                  frame.result,
                  !!outputDirectory,
                );
                taskReported = true;
                emit({ type: "task_outcome", ...report });
              }
            }
            emit({
              type: "tool",
              name: frame.toolName,
              state:
                frame.type === "tool_execution_start"
                  ? "started"
                  : frame.isError
                    ? "failed"
                    : "completed",
            });
          }
          if (frame.type === "agent_end") {
            if (conversationCallId !== undefined && !conversationReported)
              throw Error("Unfinished conversation output report");
            if (taskCallId !== undefined && !taskReported)
              throw new Error("Unfinished task report");
            if (!Array.isArray(frame.messages))
              throw new Error("Invalid OMP terminal messages");
            for (const value of frame.messages) {
              const message = object(value);
              if (typeof message.role !== "string")
                throw new Error("Invalid OMP terminal message");
              if (message.role === "assistant") {
                if (
                  !Array.isArray(message.content) ||
                  (message.stopReason !== "stop" &&
                    message.stopReason !== "toolUse")
                )
                  throw new Error("Invalid OMP terminal assistant");
                for (const value of message.content) {
                  const part = object(value);
                  if (part.type === "text" && typeof part.text === "string")
                    continue;
                  if (
                    part.type === "thinking" &&
                    typeof part.thinking === "string"
                  )
                    continue;
                  if (
                    part.type === "toolCall" &&
                    typeof part.id === "string" &&
                    typeof part.name === "string"
                  ) {
                    object(part.arguments);
                    continue;
                  }
                  throw new Error("Invalid OMP terminal content");
                }
              }
            }
            if (
              !assistantCompleted ||
              (!finalText.trim() && !conversationReported)
            )
              throw new Error("OMP ended without completed text");
            return frame;
          }
        });
        await Promise.all([
          completed,
          process.request("prompt", {
            message: input.text + attachments.context,
            ...(attachments.images.length
              ? { images: attachments.images }
              : {}),
          }),
        ]);
        const after = before && (await this.entryIds(process));
        const added =
          before && after && [...after].filter((id) => !before.has(id));
        const userEntryId =
          before &&
          after &&
          added?.length === 1 &&
          [...before].every((id) => after.has(id))
            ? added[0]
            : undefined;
        if (input.profile.memory) {
          const memory = object(
            (await process.request("prompt", { message: "/memory enqueue" }))
              .data,
          );
          if (memory.agentInvoked !== false)
            throw new RuntimeError(
              "unavailable",
              "OMP native memory enqueue not acknowledged",
            );
        }
        return {
          ...(await this.state(process)),
          ...(userEntryId ? { userEntryId } : {}),
        };
      },
      {
        runId: input.runId,
        threadId: input.threadId,
        requestInteraction: input.requestInteraction,
        task: input.task,
        conversation: input.conversation,
        hasAttachments: !!input.attachments?.length,
        outputDirectory,
      },
    );
  }
  async branchPoints(input: {
    profile: AgentProfile;
    sessionPath: string;
    signal: AbortSignal;
  }): Promise<BranchPoint[]> {
    return this.withProcess(
      input.profile,
      input.sessionPath,
      input.signal,
      undefined,
      async (process) => this.points(process),
    );
  }
  private async points(process: OmpProcess): Promise<BranchPoint[]> {
    const data = object((await process.request("get_branch_messages")).data);
    if (!Array.isArray(data.messages))
      throw new RuntimeError("unavailable", "Invalid OMP branch messages");
    return data.messages.map((value: unknown) => {
      const point = object(value);
      if (typeof point.entryId !== "string" || typeof point.text !== "string")
        throw new RuntimeError("unavailable", "Invalid OMP branch point");
      return { entryId: point.entryId, text: point.text };
    });
  }
  private async entryIds(
    process: OmpProcess,
  ): Promise<Set<string> | undefined> {
    try {
      const points = await this.points(process);
      const ids = new Set(points.map((point) => point.entryId));
      if (
        ids.size !== points.length ||
        [...ids].some(
          (id) =>
            !id ||
            id.length > 1024 ||
            /\s/.test(id) ||
            Array.from(id).some(
              (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
            ),
        )
      )
        return;
      return ids;
    } catch {
      // Older workers may lack enumeration. Never infer identity from text.
      return;
    }
  }
  async fork(
    input: Parameters<AgentWorker["fork"]>[0],
  ): Promise<{ sessionPath: string }> {
    return this.withProcess(
      input.profile,
      input.sessionPath,
      input.signal,
      (event) => {
        if (event.type === "worker_started")
          input.onProcess?.(event.pid, event.ownership);
      },
      async (process) => {
        if (
          !(await this.points(process)).some(
            (point) => point.entryId === input.entryId,
          )
        )
          throw new RuntimeError("invalid", "Unknown OMP branch point");
        const result = object(
          (await process.request("branch", { entryId: input.entryId })).data,
        );
        if (result.cancelled !== false)
          throw new RuntimeError("unavailable", "OMP branch cancelled");
        const next = await this.state(process);
        if (next.sessionPath === (await this.sessionPath(input.sessionPath)))
          throw new RuntimeError(
            "unavailable",
            "OMP branch reused parent session",
          );
        return next;
      },
    );
  }
}
