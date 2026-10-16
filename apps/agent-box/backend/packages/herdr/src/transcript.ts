import { constants } from "node:fs";
import { mkdir, open, lstat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
export interface TranscriptIdentity {
  id: string;
  runId: string;
  threadId: string;
  toolCallId: string;
}
export type TranscriptEvent =
  | { type: "started" }
  | { type: "session"; sessionId: string }
  | { type: "text"; text: string }
  | { type: "blocked"; message: string }
  | { type: "working" }
  | { type: "cancel_requested" }
  | {
      type: "completed" | "cancelled" | "failed" | "interrupted";
      message?: string;
    };
export type TranscriptStatus =
  | "working"
  | "blocked"
  | "cancel_requested"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";
export interface TranscriptRecord {
  seq: number;
  event: TranscriptEvent;
}
export interface TranscriptProjection {
  identity: TranscriptIdentity;
  status: TranscriptStatus;
  lastSeq: number;
  sessionId?: string;
  events: TranscriptRecord[];
}
const terminal = new Set(["completed", "cancelled", "failed", "interrupted"]);
export function transcriptId(id: string): string {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
  )
    throw Error("Invalid transcript id");
  return id;
}
function string(value: unknown, max = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= max
  );
}
function validateEvent(event: TranscriptEvent) {
  if (!event || typeof event !== "object")
    throw Error("Invalid transcript event");
  const keys = Object.keys(event);
  const extra =
    event.type === "session"
      ? "sessionId"
      : event.type === "text"
        ? "text"
        : event.type === "blocked" || terminal.has(event.type)
          ? "message"
          : undefined;
  if (keys.some((k) => k !== "type" && k !== extra))
    throw Error("Invalid transcript event");
  if (
    ![
      "started",
      "session",
      "text",
      "blocked",
      "working",
      "cancel_requested",
      ...terminal,
    ].includes(event.type)
  )
    throw Error("Invalid transcript event");
  if (
    (event.type === "text" && !string(event.text, 65536)) ||
    (event.type === "session" && !string(event.sessionId)) ||
    (event.type === "blocked" && !string(event.message, 4096)) ||
    ("message" in event &&
      event.message !== undefined &&
      !string(event.message, 4096))
  )
    throw Error("Invalid transcript event");
}
/** Trusted backend writer; persisted IDs associate every event with one execution. */
export class TranscriptStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly root: string,
    readonly maxBytes = 2 * 1024 * 1024,
  ) {
    if (!isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes < 8192)
      throw Error("Invalid transcript store");
  }
  path(id: string) {
    return join(this.root, transcriptId(id) + ".jsonl");
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work);
    this.queue = pending.catch(() => {});
    return pending;
  }
  async create(identity: TranscriptIdentity): Promise<void> {
    return this.serial(async () => {
      transcriptId(identity.id);
      if (
        Object.keys(identity).sort().join(",") !==
          "id,runId,threadId,toolCallId" ||
        ![identity.runId, identity.threadId, identity.toolCallId].every((v) =>
          string(v),
        )
      )
        throw Error("Invalid transcript association");
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const handle = await open(this.path(identity.id), "wx", 0o600);
      try {
        await handle.writeFile(
          JSON.stringify({ identity }) +
            "\n" +
            JSON.stringify({ seq: 1, event: { type: "started" } }) +
            "\n",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }
  async read(id: string, after = 0): Promise<TranscriptProjection> {
    if (!Number.isSafeInteger(after) || after < 0)
      throw Error("Invalid transcript cursor");
    const handle = await open(
      this.path(id),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    let text: string;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > this.maxBytes)
        throw Error("Invalid transcript file");
      const buffer = Buffer.alloc(this.maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      if (
        length > this.maxBytes ||
        after.size > this.maxBytes ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      )
        throw Error("Invalid transcript file");
      text = buffer.subarray(0, length).toString("utf8");
    } finally {
      await handle.close();
    }
    if (!text.endsWith("\n")) throw Error("Incomplete transcript");
    const lines = text
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    const identity = lines.shift()?.identity as TranscriptIdentity;
    if (
      identity?.id !== id ||
      ![identity?.runId, identity?.threadId, identity?.toolCallId].every((v) =>
        string(v),
      )
    )
      throw Error("Invalid transcript association");
    let status: TranscriptStatus = "working",
      sessionId: string | undefined,
      lastSeq = 0;
    const events: TranscriptRecord[] = [];
    for (const record of lines as TranscriptRecord[]) {
      if (record.seq !== ++lastSeq || terminal.has(status))
        throw Error("Invalid transcript sequence");
      validateEvent(record.event);
      const event = record.event;
      if (
        (lastSeq === 1 && event.type !== "started") ||
        (lastSeq > 1 && event.type === "started")
      )
        throw Error("Invalid transcript start");
      if (event.type === "session") {
        if (sessionId && sessionId !== event.sessionId)
          throw Error("Changed ACP session");
        sessionId = event.sessionId;
      } else if (
        ["blocked", "working", "cancel_requested", ...terminal].includes(
          event.type,
        )
      )
        if (status !== "cancel_requested" || terminal.has(event.type))
          status = event.type as TranscriptStatus;
      if (record.seq > after) events.push(record);
    }
    if (!lastSeq) throw Error("Missing transcript start");
    return {
      identity,
      status,
      lastSeq,
      ...(sessionId ? { sessionId } : {}),
      events,
    };
  }
  async append(id: string, event: TranscriptEvent): Promise<void> {
    return this.serial(async () => {
      validateEvent(event);
      const current = await this.read(id);
      if (terminal.has(current.status)) throw Error("Transcript is terminal");
      if (event.type === "started") throw Error("Transcript already started");
      if (
        event.type === "session" &&
        current.sessionId &&
        current.sessionId !== event.sessionId
      )
        throw Error("Changed ACP session");
      const line = JSON.stringify({ seq: current.lastSeq + 1, event }) + "\n";
      const path = this.path(id);
      const size = (await lstat(path)).size;
      const reserve = terminal.has(event.type) ? 0 : 6144;
      if (size + Buffer.byteLength(line) > this.maxBytes - reserve)
        throw Error("Transcript limit reached");
      const handle = await open(path, "a");
      try {
        await handle.writeFile(line);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }
}
