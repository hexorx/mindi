import { prepareCoordinatorAttachments } from "./attachments.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  Agent,
  type AgentMessage,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { type Api, type Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { AGENT_TOOLS, type AgentToolLease } from "@mindi/agent-tools";
import {
  RuntimeError,
  type AgentProfile,
  type AgentWorker,
  type WorkerInput,
  type WorkerEvent,
} from "@mindi/agent-runtime";
import { type DesktopToolLease } from "@mindi/desktop/agent-contract";
import { isDesktopTool } from "./desktop.js";
import { CoordinatorCredentialStore } from "./auth.js";
export { CoordinatorCredentialStore } from "./auth.js";
import { projectContext } from "./context.js";
import { coordinatorTools } from "./tools.js";
export { COORDINATOR_TOOLS } from "./tools.js";
export interface PiCoordinatorOptions {
  stateRoot: string;
  openAgentTools?: (input: {
    runId: string;
    profile: AgentProfile;
    signal: AbortSignal;
  }) => AgentToolLease;
  openDesktopTools?: (input: {
    runId: string;
    profile: AgentProfile;
    signal: AbortSignal;
  }) => DesktopToolLease;
  streamFn?: StreamFn;
  resolveModel?: (modelId: string) => Model<Api>;
  importLegacyHistory?: (input: {
    threadId: string;
    sessionPath: string;
    profile: AgentProfile;
    signal: AbortSignal;
  }) => Promise<Array<{ role: "user" | "assistant"; content: string }>>;
}
interface Journal {
  version: 1;
  engine: "pi-coordinator";
  threadId: string;
  profileId: string;
  legacySessionPath?: string;
  entries: Array<{ id: string; message: AgentMessage }>;
}
const locks = new Map<string, Promise<unknown>>();
export class PiCoordinatorWorker implements AgentWorker {
  private readonly collections;
  constructor(private readonly options: PiCoordinatorOptions) {
    this.collections = builtinModels({
      credentials: new CoordinatorCredentialStore(options.stateRoot),
    });
  }
  private path(threadId: string) {
    return join(
      resolve(this.options.stateRoot),
      "pi-coordinator",
      `${createHash("sha256").update(threadId).digest("hex")}.json`,
    );
  }
  private async save(path: string, journal: Journal) {
    await mkdir(resolve(this.options.stateRoot, "pi-coordinator"), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(journal));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(
      resolve(this.options.stateRoot, "pi-coordinator"),
      "r",
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
  private async load(path: string, profile: AgentProfile): Promise<Journal> {
    const storage = join(
      await realpath(this.options.stateRoot),
      "pi-coordinator",
    );
    const actual = await realpath(path);
    if (!actual.startsWith(`${storage}/`))
      throw new RuntimeError(
        "conflict",
        "Session path is outside coordinator storage",
      );
    const data = JSON.parse(await readFile(path, "utf8")) as Journal;
    if (
      data.version !== 1 ||
      data.engine !== "pi-coordinator" ||
      data.profileId !== profile.id ||
      !Array.isArray(data.entries)
    )
      throw new RuntimeError(
        "conflict",
        "Session is not a Pi coordinator journal for this profile",
      );
    if (
      typeof data.threadId !== "string" ||
      resolve(path) !== this.path(data.threadId)
    )
      throw new RuntimeError(
        "conflict",
        "Session path does not match its thread",
      );
    return data;
  }
  async branchPoints(
    input: Parameters<NonNullable<AgentWorker["branchPoints"]>>[0],
  ) {
    input.signal.throwIfAborted();
    const journal = await this.load(input.sessionPath, input.profile);
    return journal.entries
      .filter((e) => e.message.role === "user")
      .map((e) => ({
        entryId: e.id,
        text:
          e.message.role === "user"
            ? typeof e.message.content === "string"
              ? e.message.content
              : e.message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("\n")
            : "",
      }));
  }
  async fork(input: Parameters<AgentWorker["fork"]>[0]) {
    input.signal.throwIfAborted();
    const journal = await this.load(input.sessionPath, input.profile);
    const index = journal.entries.findIndex(
      (e) => e.id === input.entryId && e.message.role === "user",
    );
    if (index < 0)
      throw new RuntimeError("not_found", "Branch point not found");
    const sessionPath = this.path(input.threadId);
    if (resolve(sessionPath) === resolve(input.sessionPath))
      throw new RuntimeError("conflict", "Cannot overwrite parent session");
    await this.save(sessionPath, {
      ...journal,
      threadId: input.threadId,
      entries: journal.entries.slice(0, index),
    });
    return { sessionPath };
  }
  async run(input: WorkerInput, emit: (event: WorkerEvent) => void) {
    const path = this.path(input.threadId);
    const prior = locks.get(path) ?? Promise.resolve();
    const run = prior
      .catch(() => {})
      .then(() => this.execute(input, emit, path));
    locks.set(path, run);
    const cleanup = () => {
      if (locks.get(path) === run) locks.delete(path);
    };
    void run.then(cleanup, cleanup);
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () =>
        reject(new RuntimeError("cancelled", "Coordinator run cancelled"));
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
    });
    try {
      return await Promise.race([run, cancelled]);
    } finally {
      input.signal.removeEventListener("abort", abort);
    }
  }
  private async execute(
    input: WorkerInput,
    emit: (event: WorkerEvent) => void,
    sessionPath: string,
  ) {
    input.signal.throwIfAborted();
    if (!input.profile.modelIds.includes(input.modelId))
      throw new RuntimeError(
        "invalid",
        "Model is not allowed for this coordinator",
      );
    const slash = input.modelId.indexOf("/");
    const model =
      this.options.resolveModel?.(input.modelId) ??
      this.collections.getModel(
        input.modelId.slice(0, slash),
        input.modelId.slice(slash + 1),
      );
    if (!model)
      throw new RuntimeError(
        "unavailable",
        `Unsupported Pi coordinator model: ${input.modelId}`,
      );
    const attachments = await prepareCoordinatorAttachments(
      input,
      this.options.stateRoot,
    );
    if (attachments.images.length && !model.input.includes("image"))
      throw new RuntimeError(
        "invalid",
        "Coordinator model does not accept attachment images",
      );
    let journal: Journal;
    try {
      journal = await this.load(sessionPath, input.profile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (input.sessionPath && resolve(input.sessionPath) === sessionPath)
        throw new RuntimeError(
          "conflict",
          "Referenced Pi coordinator session is missing",
        );
      journal = {
        version: 1,
        engine: "pi-coordinator",
        threadId: input.threadId,
        profileId: input.profile.id,
        entries: [],
      };
      if (input.sessionPath && resolve(input.sessionPath) !== sessionPath) {
        if (!this.options.importLegacyHistory)
          throw new RuntimeError(
            "conflict",
            "Legacy coordinator history requires explicit import",
          );
        const history = await this.options.importLegacyHistory({
          threadId: input.threadId,
          sessionPath: input.sessionPath,
          profile: input.profile,
          signal: input.signal,
        });
        journal.legacySessionPath = input.sessionPath;
        journal.entries = history.map((message) => ({
          id: randomUUID(),
          message: {
            role: "user",
            content: `Historical ${message.role} (already occurred; do not replay side effects):\n${message.content}`,
            timestamp: Date.now(),
          },
        }));
      }
    }
    // A crash may happen after a durable tool intent but before the result.
    // Record uncertainty without re-executing the historical call.
    const completed = new Set(
      journal.entries.flatMap((e) =>
        e.message.role === "toolResult" ? [e.message.toolCallId] : [],
      ),
    );
    for (const entry of [...journal.entries])
      if (
        entry.message.role === "assistant" &&
        entry.message.stopReason !== "error" &&
        entry.message.stopReason !== "aborted"
      )
        for (const block of entry.message.content)
          if (block.type === "toolCall" && !completed.has(block.id)) {
            journal.entries.push({
              id: randomUUID(),
              message: {
                role: "toolResult",
                toolCallId: block.id,
                toolName: block.name,
                content: [
                  {
                    type: "text",
                    text: "Recovery: this historical tool outcome is unknown. Its effect may already have occurred. Inspect authoritative state and ask the human before retrying any mutation.",
                  },
                ],
                isError: true,
                timestamp: Date.now(),
              },
            });
            completed.add(block.id);
          }
    await this.save(sessionPath, journal);
    let lease: AgentToolLease | undefined;
    let desktopLease: DesktopToolLease | undefined;
    try {
      const tools = input.profile.tools ?? AGENT_TOOLS;
      if (tools.some((t) => (AGENT_TOOLS as readonly string[]).includes(t))) {
        if (!this.options.openAgentTools)
          throw new RuntimeError(
            "unavailable",
            "Coordinator agent tools unavailable",
          );
        lease = this.options.openAgentTools({
          runId: input.runId,
          profile: input.profile,
          signal: input.signal,
        });
      }
      if (tools.some(isDesktopTool)) {
        if (!this.options.openDesktopTools)
          throw new RuntimeError(
            "unavailable",
            "Coordinator desktop tools unavailable",
          );
        desktopLease = this.options.openDesktopTools({
          runId: input.runId,
          profile: input.profile,
          signal: input.signal,
        });
      }
      const systemPrompt = `${input.profile.instructions}\nYou are the embedded human/team coordinator. Delegate all coding and code review to specialist agents; Use your granted desktop capture and input tools for basic research in your own persona desktop. Do not use desktop input to run commands or edit code. Focus on understanding the human, managing the team, and communicating verified outcomes. Use durable task and messaging tools for asynchronous execution. Keep task IDs, approval decisions and active commitments exact. Never claim completed work or saved/recalled Hindsight memory without successful tool evidence. Historical effects must never be replayed automatically.`;
      const permittedTools = coordinatorTools(
        input,
        lease,
        () => journal.entries,
        desktopLease,
      );
      const reservedBytes =
        Buffer.byteLength(systemPrompt) +
        Buffer.byteLength(JSON.stringify(permittedTools));
      const agent = new Agent({
        initialState: {
          systemPrompt,
          model,
          messages: journal.entries.map((e) => e.message),
          tools: permittedTools,
        },
        streamFn: (m, c, o) =>
          (
            this.options.streamFn ??
            ((selected, context, options) =>
              this.collections.streamSimple(selected, context, options))
          )(m, c, { ...o, maxTokens: Math.min(8192, m.maxTokens) }),
        transformContext: (messages, signal) =>
          projectContext(
            messages,
            model,
            signal,
            reservedBytes,
            permittedTools.some((tool) => tool.name === "history_read"),
          ),
        toolExecution: "sequential",
        maxRetryDelayMs: 5000,
      });
      let userEntryId: string | undefined;
      agent.subscribe(async (event) => {
        if (event.type === "message_end") {
          const id = randomUUID();
          if (event.message.role === "user" && !userEntryId) userEntryId = id;
          journal.entries.push({
            id,
            message: structuredClone(event.message),
          });
          await this.save(sessionPath, journal);
        } else if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        )
          emit({ type: "text", text: event.assistantMessageEvent.delta });
        else if (event.type === "tool_execution_start")
          emit({ type: "tool", name: event.toolName, state: "started" });
        else if (event.type === "tool_execution_end")
          emit({
            type: "tool",
            name: event.toolName,
            state: event.isError ? "failed" : "completed",
          });
      });
      const abort = () => agent.abort();
      input.signal.addEventListener("abort", abort, { once: true });
      try {
        input.signal.throwIfAborted();
        await agent.prompt(
          input.text + attachments.context,
          attachments.images,
        );
        input.signal.throwIfAborted();
        if (agent.state.errorMessage)
          throw new RuntimeError("unavailable", agent.state.errorMessage);
      } finally {
        input.signal.removeEventListener("abort", abort);
      }
      await this.save(sessionPath, journal);
      return { sessionPath, userEntryId };
    } finally {
      desktopLease?.close();
      lease?.close();
    }
  }
}
