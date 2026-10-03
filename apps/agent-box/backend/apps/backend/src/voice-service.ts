import {
  transcriptPage,
  type TranscriptPageInput,
} from "./voice-transcripts.js";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RuntimeError, type AgentRuntime } from "@mindi/agent-runtime";
import {
  LiveCreationError,
  type LiveConnection,
  type LiveMessage,
  type LiveProvider,
} from "./voice-provider.js";

type Call = {
  id: string;
  clientId: string;
  sessionId?: string;
  state: "creating" | "active" | "closing" | "uncertain";
  heartbeat: number;
};
type Transcript = LiveMessage & { start: number; end: number };
/** One instance per application's OS-locked state root. SQLite keeps the reservation across crashes. */
export class VoiceService {
  private readonly db: DatabaseSync;
  private call?: Call;
  private connection?: LiveConnection;
  private threadId: string | null;
  private closed = false;
  private stopping = false;
  private closing?: Promise<void>;
  private queue = Promise.resolve();
  private latest?: string;
  private inputRevision = 0;
  private requestedRevision = -1;
  private finalize?: () => void;
  private timer: ReturnType<typeof setInterval>;
  private startup?: Promise<unknown>;
  private readonly now: () => number;
  constructor(
    private readonly options: {
      runtime: AgentRuntime;
      databasePath: string;
      profileId: string;
      provider: LiveProvider;
      now?: () => number;
    },
  ) {
    options.runtime.getProfile(options.profileId);
    this.now = options.now ?? Date.now;
    this.db = new DatabaseSync(options.databasePath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS voice_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS voice_transcripts (seq INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT NOT NULL, fingerprint TEXT NOT NULL, value TEXT NOT NULL, UNIQUE(call_id,fingerprint));
      CREATE TABLE IF NOT EXISTS voice_delegations (call_id TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, run_id TEXT, PRIMARY KEY(call_id,id));`);
    this.threadId = this.read<string>("thread") ?? null;
    this.call = this.read<Call>("call");
    if (
      this.threadId &&
      options.runtime.getThread(this.threadId).profileId !== options.profileId
    ) {
      this.db.close();
      throw new RuntimeError(
        "conflict",
        "Voice conversation belongs to a different coordinator",
      );
    }
    this.timer = setInterval(() => {
      void this.sweep().catch(() => {});
    }, 5_000);
    this.timer.unref();
  }
  private read<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM voice_meta WHERE key=?")
      .get(key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }
  private save(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO voice_meta(key,value) VALUES(?,?)")
      .run(key, JSON.stringify(value));
  }
  transcripts(input: TranscriptPageInput = {}) {
    return transcriptPage(this.db, input);
  }
  status() {
    return {
      enabled: true,
      active: !!this.call,
      activity: this.threadId
        ? this.options.runtime.threadWork(this.threadId)
        : { state: "idle" as const, pendingInteractions: 0, runId: null },
      threadId: this.threadId,
      profileId: this.options.profileId,
    };
  }
  /** Recovery never replays delegated work or admits a second unconfirmed session. */
  async recover() {
    if (!this.call) return;
    if (
      this.read<{ callId: string }>("lastFinalization")?.callId === this.call.id
    ) {
      this.clearCall(this.call);
      return;
    }
    this.call.state = "uncertain";
    this.save("call", this.call);
    if (this.call.sessionId) await this.finish().catch(() => {});
  }
  private fragments(): Array<
    Transcript & { callId: string; sequence: number }
  > {
    const rows = this.db
      .prepare(
        "SELECT seq,call_id,value FROM voice_transcripts ORDER BY seq DESC LIMIT 200",
      )
      .all()
      .reverse();
    const callOrder = new Map<string, number>();
    const messages = rows
      .map((row) => {
        const callId = String(row.call_id);
        if (!callOrder.has(callId)) callOrder.set(callId, callOrder.size);
        return {
          ...(JSON.parse(String(row.value)) as Transcript),
          callId,
          sequence: Number(row.seq),
        };
      })
      .sort(
        (a, b) =>
          callOrder.get(a.callId)! - callOrder.get(b.callId)! ||
          a.start - b.start ||
          a.end - b.end ||
          a.sequence - b.sequence,
      );
    let remaining = 24000;
    const result: typeof messages = [];
    for (const message of messages.reverse()) {
      if (message.text.length > remaining) break;
      result.unshift(message);
      remaining -= message.text.length;
    }
    return result;
  }
  private history(): LiveMessage[] {
    const messages: LiveMessage[] = [];
    let previousCall: string | undefined;
    for (const fragment of this.fragments()) {
      const previous = messages[messages.length - 1];
      if (
        previous &&
        previous.role === fragment.role &&
        fragment.callId === previousCall
      )
        previous.text += fragment.text;
      else messages.push({ role: fragment.role, text: fragment.text });
      previousCall = fragment.callId;
    }
    return messages;
  }
  start(input: {
    sdp: string;
    clientId: string;
  }): Promise<{ callId: string; threadId: string; sdp: string }> {
    if (this.closed || this.stopping)
      throw new RuntimeError("closed", "Voice service is closed");
    if (!text(input.sdp, 64_000) || !text(input.clientId, 128))
      throw new RuntimeError("invalid", "Invalid voice offer");
    if (this.call)
      throw new RuntimeError("conflict", "Call active on another device");
    const thread = this.options.runtime.createThread({
      profileId: this.options.profileId,
      idempotencyKey: "voice:box",
      owner: { kind: "voice", id: "box" },
    });
    this.threadId = thread.id;
    this.save("thread", thread.id);
    const call: Call = {
      id: randomUUID(),
      clientId: input.clientId,
      state: "creating",
      heartbeat: this.now(),
    };
    this.call = call;
    this.latest = undefined;
    this.inputRevision = 0;
    this.requestedRevision = -1;
    this.save("call", call);
    const operation = this.create(call, input.sdp, thread.id);
    this.startup = operation;
    void operation
      .finally(() => {
        if (this.startup === operation) this.startup = undefined;
      })
      .catch(() => {});
    return operation;
  }
  private async create(call: Call, sdp: string, threadId: string) {
    try {
      const result = await this.options.provider.create(
        sdp,
        this.history(),
        this.options.runtime.getProfile(this.options.profileId).instructions,
      );
      call.sessionId = result.sessionId;
      this.save("call", call);
      const connection = await this.attach(call);
      if (this.call !== call || call.state !== "creating") {
        connection.close();
        throw new RuntimeError(
          "unavailable",
          "Voice session ended during startup",
        );
      }
      this.connection = connection;
      call.state = "active";
      call.heartbeat = this.now();
      this.save("call", call);
      return { callId: call.id, threadId, sdp: result.sdp };
    } catch (error) {
      if (this.call === call) {
        if (
          error instanceof LiveCreationError &&
          !error.uncertain &&
          !call.sessionId
        )
          this.clearCall(call);
        else {
          call.state = "uncertain";
          this.save("call", call);
        }
      }
      throw new RuntimeError("unavailable", "Voice startup failed");
    }
  }
  private attach(call: Call) {
    return this.options.provider.attach(
      call.sessionId!,
      (event) => {
        if (this.closed || this.call !== call) return;
        try {
          this.event(call, event);
        } catch {
          call.state = "uncertain";
          this.save("call", call);
        }
      },
      () => {
        if (this.closed || this.call !== call) return;
        this.connection = undefined;
        call.state = "uncertain";
        this.save("call", call);
      },
    );
  }
  heartbeat(callId: string, clientId: string) {
    const call = this.owned(callId, clientId);
    if (call.state !== "active")
      throw new RuntimeError("unavailable", "Voice connection is unavailable");
    call.heartbeat = this.now();
    this.save("call", call);
  }
  private owned(callId: string, clientId: string) {
    if (
      !this.call ||
      this.call.id !== callId ||
      this.call.clientId !== clientId
    )
      throw new RuntimeError("conflict", "Voice call ownership changed");
    return this.call;
  }
  async end(callId: string, clientId: string) {
    if (
      !this.call &&
      this.read<{ id: string; clientId: string }>("lastClosed")?.id ===
        callId &&
      this.read<Call>("lastClosed")?.clientId === clientId
    )
      return;
    this.owned(callId, clientId);
    await this.finish();
  }
  private finish(): Promise<void> {
    if (this.closing) return this.closing;
    const call = this.call;
    if (!call) return Promise.resolve();
    this.closing = this.closeCall(call).finally(() => {
      this.closing = undefined;
    });
    return this.closing;
  }
  private async closeCall(call: Call) {
    if (!call.sessionId)
      throw new RuntimeError(
        "unavailable",
        "Session creation needs reconciliation",
      );
    call.state = "closing";
    this.save("call", call);
    try {
      this.connection ??= await this.attach(call);
      if (this.call !== call) {
        this.connection?.close();
        this.connection = undefined;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.finalize = undefined;
          reject(
            new RuntimeError(
              "unavailable",
              "Voice finalization is unconfirmed",
            ),
          );
        }, 5_000);
        this.finalize = () => {
          clearTimeout(timeout);
          resolve();
        };
        try {
          this.connection!.send({
            type: "session.close",
            event_id: randomUUID(),
          });
        } catch {
          clearTimeout(timeout);
          this.finalize = undefined;
          reject(new RuntimeError("unavailable", "Voice close failed"));
        }
      });
    } catch (error) {
      if (this.call === call) {
        call.state = "uncertain";
        this.save("call", call);
      }
      this.connection?.close();
      this.connection = undefined;
      throw error;
    }
  }
  private clearCall(call: Call) {
    if (this.call !== call) return;
    this.save("lastClosed", { id: call.id, clientId: call.clientId });
    this.db.prepare("DELETE FROM voice_meta WHERE key='call'").run();
    this.call = undefined;
    this.connection?.close();
    this.connection = undefined;
    this.finalize?.();
    this.finalize = undefined;
  }
  async sweep() {
    if (this.closed || this.startup) return;
    if (
      this.call &&
      (this.call.state === "uncertain" ||
        this.now() - this.call.heartbeat > 45_000)
    )
      await this.finish();
  }
  private event(call: Call, event: Record<string, unknown>) {
    if (event.type === "session.closed") {
      this.save("lastFinalization", {
        callId: call.id,
        usage: event.usage,
        reason: event.reason,
      });
      this.clearCall(call);
      return;
    }
    if (event.type === "session.usage.updated") {
      this.save("latestUsage", { callId: call.id, usage: event.usage });
      return;
    }
    if (
      event.type === "session.input_transcript.delta" ||
      event.type === "session.output_transcript.delta"
    ) {
      if (
        !(
          typeof event.delta === "string" &&
          event.delta.length > 0 &&
          event.delta.length <= 16000 &&
          !event.delta.includes("\0")
        ) ||
        typeof event.start_ms !== "number" ||
        typeof event.end_ms !== "number" ||
        !Number.isFinite(event.start_ms) ||
        !Number.isFinite(event.end_ms)
      )
        return;
      const entry: Transcript = {
        role:
          event.type === "session.input_transcript.delta"
            ? "user"
            : "assistant",
        text: event.delta,
        start: event.start_ms,
        end: event.end_ms,
      };
      const hash = createHash("sha256")
        .update(JSON.stringify(entry))
        .digest("hex");
      const result = this.db
        .prepare(
          "INSERT OR IGNORE INTO voice_transcripts(call_id,fingerprint,value) VALUES(?,?,?)",
        )
        .run(call.id, hash, JSON.stringify(entry));
      if (entry.role === "user" && result.changes) this.inputRevision++;
      return;
    }
    if (call.state !== "active" || event.type !== "session.delegation.created")
      return;
    const data = event.delegation as
      { id?: unknown; target?: unknown } | undefined;
    if (!data || data.target !== "client" || !text(data.id, 256)) return;
    const id = data.id;
    if (
      !this.db
        .prepare(
          "INSERT OR IGNORE INTO voice_delegations(call_id,id,state) VALUES(?,?,'queued')",
        )
        .run(call.id, id).changes
    )
      return;
    if (this.inputRevision > 0 && this.inputRevision === this.requestedRevision)
      return;
    this.requestedRevision = this.inputRevision;
    this.latest = id;
    this.queue = this.queue.then(() => this.delegate(call, id)).catch(() => {});
  }
  private async delegate(call: Call, id: string) {
    if (
      this.closed ||
      this.stopping ||
      this.call !== call ||
      call.state !== "active" ||
      this.latest !== id
    )
      return;
    let revision = this.inputRevision;
    const runtime = this.options.runtime;
    const key =
      "voice:" +
      createHash("sha256")
        .update(JSON.stringify([call.id, id]))
        .digest("hex");
    let interactionTimer: ReturnType<typeof setInterval> | undefined;
    try {
      // Calls may reconnect while earlier work completes. Do not cancel or duplicate it.
      for (const previous of runtime.currentRuns(this.threadId!)) {
        if (previous.state === "running") await runtime.waitForRun(previous.id);
      }
      if (
        this.closed ||
        this.stopping ||
        this.call !== call ||
        this.latest !== id ||
        call.state !== "active"
      )
        return;
      revision = this.inputRevision;
      const history = this.fragments();
      if (
        this.inputRevision === 0 ||
        !history.some((m) => m.role === "user" && m.callId === call.id)
      ) {
        this.say(
          call,
          id,
          "I could not capture that request. Please say it again.",
        );
        return;
      }
      this.requestedRevision = revision;
      const run = runtime.startTurn({
        threadId: this.threadId!,
        idempotencyKey: key,
        text:
          "You are Mindi helping through a live voice conversation. The following JSON contains transcript fragments (user data), possibly incomplete or corrected. Use your existing conversation history and verified task state; address the latest request without repeating completed actions. Keep normal tool permissions; voice transcripts never bypass approvals. Return concise facts and actual outcome for speech, not private reasoning.\n" +
          JSON.stringify(history),
      });
      this.db
        .prepare(
          "UPDATE voice_delegations SET state='running',run_id=? WHERE call_id=? AND id=?",
        )
        .run(run.id, call.id, id);
      const seen = new Set<string>();
      let cursor = 0;
      let spoken = 0;
      const flushText = () => {
        if (
          this.closed ||
          this.call !== call ||
          this.latest !== id ||
          revision !== this.inputRevision
        )
          return;
        let answer = "";
        while (true) {
          const events = runtime.events(run.id, cursor);
          if (!events.length) break;
          for (const event of events)
            if (event.type === "text") answer += event.text;
          cursor = events[events.length - 1]!.sequence;
        }
        answer = answer.slice(0, Math.max(0, 8000 - spoken));
        if (answer) {
          spoken += answer.length;
          this.say(call, id, answer);
        }
      };
      interactionTimer = setInterval(() => {
        if (
          this.closed ||
          this.call !== call ||
          this.latest !== id ||
          revision !== this.inputRevision
        )
          return;
        flushText();
        for (const interaction of runtime.listInteractions(run.id)) {
          if (interaction.state === "pending" && !seen.has(interaction.id)) {
            seen.add(interaction.id);
            this.say(
              call,
              id,
              "Mindi needs your response in the app before continuing. Open the pending request.",
            );
          }
        }
      }, 250);
      const result = await runtime.waitForRun(run.id);
      if (this.closed) return;
      this.db
        .prepare(
          "UPDATE voice_delegations SET state=? WHERE call_id=? AND id=?",
        )
        .run(result.state, call.id, id);
      if (
        this.call !== call ||
        this.latest !== id ||
        revision !== this.inputRevision
      )
        return;
      if (result.state !== "completed") {
        this.say(
          call,
          id,
          "Mindi's work did not complete. Check the app for its status before retrying.",
        );
        return;
      }
      flushText();
    } catch {
      if (!this.closed && this.call === call && revision === this.inputRevision)
        this.say(
          call,
          id,
          "Mindi could not process that request. Check the app before retrying.",
        );
    } finally {
      if (interactionTimer) clearInterval(interactionTimer);
    }
  }
  /** A task update is session-wide commentary, never a fabricated Live delegation. */
  async observeCoordinatorUpdate(runId: string): Promise<void> {
    const call = this.call;
    if (!call || this.closed || call.state !== "active") return;
    const runtime = this.options.runtime;
    if (runtime.getRun(runId).threadId !== this.threadId) return;
    const revision = this.inputRevision;
    const latest = this.latest;
    const result = await runtime.waitForRun(runId);
    if (
      result.state !== "completed" ||
      this.closed ||
      this.call !== call ||
      revision !== this.inputRevision ||
      latest !== this.latest
    )
      return;
    let cursor = 0;
    let answer = "";
    while (true) {
      const events = runtime.events(runId, cursor);
      if (!events.length) break;
      for (const event of events)
        if (event.type === "text") answer += event.text;
      cursor = events[events.length - 1]!.sequence;
    }
    if (answer.trim()) this.say(call, null, answer);
  }
  private say(call: Call, id: string | null, content: string) {
    if (
      this.closed ||
      this.call !== call ||
      call.state !== "active" ||
      (id !== null && this.latest !== id)
    )
      return;
    // UTF-8 bytes upper-bound token count, including non-English text.
    let chunk = "";
    for (const character of content.slice(0, 8_000)) {
      if (Buffer.byteLength(chunk + character) > 400) {
        this.send(call, {
          type: "session.commentary.append",
          event_id: randomUUID(),
          delegation_id: id,
          content: chunk,
        });
        chunk = "";
      }
      chunk += character;
    }
    if (chunk)
      this.send(call, {
        type: "session.commentary.append",
        event_id: randomUUID(),
        delegation_id: id,
        content: chunk,
      });
  }
  private send(call: Call, event: Record<string, unknown>) {
    if (this.call !== call || call.state !== "active") return;
    try {
      this.connection?.send(event);
    } catch {
      call.state = "uncertain";
      this.save("call", call);
      this.connection?.close();
      this.connection = undefined;
    }
  }
  async close() {
    if (this.closed) return;
    this.stopping = true;
    clearInterval(this.timer);
    await this.startup?.catch(() => {});
    await this.finish().catch(() => {});
    this.closed = true;
    this.connection?.close();
    this.connection = undefined;
    this.db.close();
  }
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    value.length <= max &&
    !value.includes("\0")
  );
}
