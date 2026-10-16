import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  transcriptId,
  type OwnedPane,
  type TranscriptIdentity,
} from "@mindi/herdr";
export type ViewerOwner = TranscriptIdentity & { profileId: string };
export type ViewerEventKind =
  | "open_requested"
  | "opened"
  | "open_uncertain"
  | "close_requested"
  | "closed"
  | "close_uncertain"
  | "session_unavailable";
export interface ViewerEvent {
  seq: number;
  at: number;
  sessionId: string;
  kind: ViewerEventKind;
  pane?: OwnedPane;
}
export interface ViewerActivity extends ViewerEvent {
  owner: ViewerOwner;
}
const kinds: ViewerEventKind[] = [
  "open_requested",
  "opened",
  "open_uncertain",
  "close_requested",
  "closed",
  "close_uncertain",
  "session_unavailable",
];
function ownerKey(owner: ViewerOwner) {
  transcriptId(owner.id);
  const values = [
    owner.id,
    owner.runId,
    owner.threadId,
    owner.toolCallId,
    owner.profileId,
  ];
  if (
    values.some(
      (v) => typeof v !== "string" || !v || Buffer.byteLength(v) > 256,
    )
  )
    throw Error("Invalid viewer owner");
  return JSON.stringify(values);
}
function checkPane(pane: OwnedPane, id: string) {
  if (
    !pane ||
    typeof pane !== "object" ||
    Array.isArray(pane) ||
    Object.keys(pane).length !== 4 ||
    pane.transcriptId !== id ||
    [pane.paneId, pane.terminalId, pane.workspaceId].some(
      (v) => typeof v !== "string" || !v || Buffer.byteLength(v) > 256,
    )
  )
    throw Error("Invalid viewer pane");
}
function decodeOwner(identity: unknown, id: unknown): ViewerOwner {
  if (typeof identity !== "string") throw Error("Invalid viewer owner");
  const fields: unknown = JSON.parse(identity);
  if (!Array.isArray(fields) || fields.length !== 5)
    throw Error("Invalid viewer owner");
  const owner = {
    id: fields[0],
    runId: fields[1],
    threadId: fields[2],
    toolCallId: fields[3],
    profileId: fields[4],
  } as ViewerOwner;
  if (owner.id !== id || ownerKey(owner) !== identity)
    throw Error("Invalid viewer owner");
  return owner;
}
function decodeEvent(
  row: Record<string, unknown>,
  owner: ViewerOwner,
): ViewerEvent {
  if (
    !Number.isSafeInteger(row.seq) ||
    Number(row.seq) <= 0 ||
    !Number.isSafeInteger(row.at) ||
    Number(row.at) <= 0 ||
    Number(row.at) > 8_640_000_000_000_000 ||
    typeof row.session_id !== "string" ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.session_id) ||
    !kinds.includes(row.kind as ViewerEventKind)
  )
    throw Error("Invalid viewer history record");
  const pane =
    row.pane === null ? undefined : (JSON.parse(String(row.pane)) as OwnedPane);
  if (pane !== undefined) checkPane(pane, owner.id);
  if ((row.kind === "opened") !== (pane !== undefined))
    throw Error("Invalid viewer history pane");
  return {
    seq: Number(row.seq),
    at: Number(row.at),
    sessionId: row.session_id,
    kind: row.kind as ViewerEventKind,
    ...(pane ? { pane } : {}),
  };
}
function bounds(after: number, limit: number) {
  if (
    !Number.isSafeInteger(after) ||
    after < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw Error("Invalid viewer history page");
}
/** Historical receipts only. Never grants authority to adopt or control a pane. */
export class ViewerHistory {
  private db: DatabaseSync;
  private closed = false;
  readonly sessionId = randomUUID();
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS viewer_owners(id TEXT PRIMARY KEY,identity TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS viewer_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,owner_id TEXT NOT NULL REFERENCES viewer_owners(id),at INTEGER NOT NULL,session_id TEXT NOT NULL,kind TEXT NOT NULL,pane TEXT) STRICT; CREATE INDEX IF NOT EXISTS viewer_events_owner ON viewer_events(owner_id,seq);",
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  private verify(owner: ViewerOwner) {
    const identity = ownerKey(owner);
    const saved = this.db
      .prepare("SELECT identity FROM viewer_owners WHERE id=?")
      .get(owner.id);
    if (saved && saved.identity !== identity)
      throw Error("Viewer owner mismatch");
    return identity;
  }
  append(owner: ViewerOwner, kind: ViewerEventKind, pane?: OwnedPane) {
    if (
      !kinds.includes(kind) ||
      (kind === "opened" && !pane) ||
      (kind !== "opened" && pane)
    )
      throw Error("Invalid viewer event");
    if (pane) checkPane(pane, owner.id);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const identity = this.verify(owner);
      this.db
        .prepare("INSERT OR IGNORE INTO viewer_owners(id,identity) VALUES(?,?)")
        .run(owner.id, identity);
      this.db
        .prepare(
          "INSERT INTO viewer_events(owner_id,at,session_id,kind,pane) VALUES(?,?,?,?,?)",
        )
        .run(
          owner.id,
          Date.now(),
          this.sessionId,
          kind,
          pane ? JSON.stringify(pane) : null,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  read(
    owner: ViewerOwner,
    after = 0,
    limit = 100,
  ): { items: ViewerEvent[]; nextSeq: number | null } {
    bounds(after, limit);
    this.verify(owner);
    const rows = this.db
      .prepare(
        "SELECT seq,at,session_id,kind,pane FROM viewer_events WHERE owner_id=? AND seq>? ORDER BY seq LIMIT ?",
      )
      .all(owner.id, after, limit + 1);
    const items = rows.slice(0, limit).map((row) => decodeEvent(row, owner));
    return { items, nextSeq: rows.length > limit ? items.at(-1)!.seq : null };
  }
  /** Historical box receipts, including closed viewers; no current control authority. */
  readActivity(
    after = 0,
    limit = 100,
  ): { items: ViewerActivity[]; nextSeq: number | null } {
    bounds(after, limit);
    const rows = this.db
      .prepare(
        `SELECT e.seq,e.owner_id,e.at,e.session_id,e.kind,e.pane,o.identity FROM viewer_events e LEFT JOIN viewer_owners o ON o.id=e.owner_id ${after ? "WHERE e.seq<?" : ""} ORDER BY e.seq DESC LIMIT ?`,
      )
      .all(...(after ? [after, limit + 1] : [limit + 1]));
    const items = rows.slice(0, limit).map((row) => {
      const owner = decodeOwner(row.identity, row.owner_id);
      return { ...decodeEvent(row, owner), owner };
    });
    return { items, nextSeq: rows.length > limit ? items.at(-1)!.seq : null };
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}
