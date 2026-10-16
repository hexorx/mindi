import type { DatabaseSync } from "node:sqlite";
import type { RoutineExternalDelivery } from "./external-delivery.js";
import type { RoutineDeliveryOperations } from "./delivery-operations.js";
import { RoutineError, plain, str } from "./types.js";
export type UploadPhase = "allocation" | "upload" | "share";
type PhaseState =
  "pending" | "in_flight" | "acknowledged" | "rejected" | "uncertain";
export interface UploadScope {
  workspaceId: string;
  actorId: string;
  manifestFingerprint: string;
}
export interface UploadJournalEntry extends UploadScope {
  ownership: string;
  attemptId: string;
  allocation: PhaseState;
  upload: PhaseState;
  share: PhaseState;
  fileId?: string;
  uploadUrl?: string;
  receipt?: string;
  rejectedAttemptId?: string;
}
function conflict(): never {
  throw new RoutineError("conflict", "Private upload state conflicts");
}
/** Private backend storage. Never included in public progress or renderer readers. */
export class RoutineDeliveryUploadJournal {
  constructor(
    private db: DatabaseSync,
    private parent: (id: string) => RoutineExternalDelivery,
    private operations: RoutineDeliveryOperations,
    private atomic: <T>(run: () => T) => T,
    private now: () => number,
  ) {}
  private admitted(id: string, attemptId: string, read = false) {
    const d = this.parent(id);
    if (
      d.attemptId !== attemptId ||
      !(d.state === "sending" || (read && d.state === "uncertain"))
    )
      conflict();
    return d;
  }
  private ownership(id: string, index: number) {
    const d = this.parent(id);
    const op = this.operations.list(id)[index];
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      !op ||
      op.kind !== "attachment" ||
      d.target.platform !== "slack"
    )
      conflict();
    return JSON.stringify([d.profileId, d.target, op.key, op.payload]);
  }
  get(
    id: string,
    attemptId: string,
    index: number,
  ): UploadJournalEntry | undefined {
    this.admitted(id, attemptId, true);
    const ownership = this.ownership(id, index);
    const row = this.db
      .prepare(
        "SELECT data FROM external_delivery_uploads WHERE delivery_id=? AND operation_index=?",
      )
      .get(id, index);
    if (!row) return;
    const entry = JSON.parse(row.data as string) as UploadJournalEntry;
    if (entry.ownership !== ownership) conflict();
    return entry;
  }
  private save(id: string, index: number, e: UploadJournalEntry) {
    this.db
      .prepare(
        "INSERT INTO external_delivery_uploads(delivery_id,operation_index,data) VALUES(?,?,?) ON CONFLICT(delivery_id,operation_index) DO UPDATE SET data=excluded.data",
      )
      .run(id, index, JSON.stringify(e));
  }
  prepare(id: string, attemptId: string, index: number, scope: UploadScope) {
    plain(scope, ["workspaceId", "actorId", "manifestFingerprint"]);
    const normalized = {
      workspaceId: str(scope.workspaceId, "workspace", 128),
      actorId: str(scope.actorId, "actor", 128),
      manifestFingerprint: str(scope.manifestFingerprint, "manifest", 1024),
    };
    const write = () => {
      this.admitted(id, attemptId);
      let e = this.get(id, attemptId, index);
      if (e) {
        if (
          e.workspaceId !== normalized.workspaceId ||
          e.actorId !== normalized.actorId ||
          e.manifestFingerprint !== normalized.manifestFingerprint
        )
          conflict();
        if (e.attemptId !== attemptId) {
          if (
            [e.allocation, e.upload, e.share].some(
              (s) => s === "in_flight" || s === "uncertain",
            )
          )
            conflict();
          e.attemptId = attemptId;
        }
      } else
        e = {
          ...normalized,
          ownership: this.ownership(id, index),
          attemptId,
          allocation: "pending",
          upload: "pending",
          share: "pending",
        };
      this.save(id, index, e);
      return e;
    };
    const operation = this.operations.list(id)[index];
    if (operation && ["pending", "rejected"].includes(operation.state)) {
      let entry!: UploadJournalEntry;
      this.operations.claim(id, attemptId, index, () => {
        entry = write();
      });
      return entry;
    }
    return this.atomic(() => {
      const current = this.operations.list(id)[index];
      if (current?.attemptId !== attemptId || current.state !== "sending")
        conflict();
      return write();
    });
  }
  private change(
    id: string,
    attemptId: string,
    index: number,
    run: (e: UploadJournalEntry) => void,
  ) {
    return this.atomic(() => {
      this.admitted(id, attemptId);
      const e = this.get(id, attemptId, index);
      if (!e || e.attemptId !== attemptId) conflict();
      const op = this.operations.list(id)[index];
      if (op?.state !== "sending" || op.attemptId !== attemptId) conflict();
      run(e);
      this.save(id, index, e);
      return e;
    });
  }
  intent(id: string, attemptId: string, index: number, phase: UploadPhase) {
    return this.change(id, attemptId, index, (e) => {
      if (
        !["allocation", "upload", "share"].includes(phase) ||
        !["pending", "rejected"].includes(e[phase]) ||
        (e[phase] === "rejected" && e.rejectedAttemptId === attemptId)
      )
        conflict();
      this.assertWorkspaceAvailable(e.workspaceId);
      if (
        phase === "upload" &&
        (e.allocation !== "acknowledged" || !e.fileId || !e.uploadUrl)
      )
        conflict();
      if (phase === "share" && e.upload !== "acknowledged") conflict();
      e[phase] = "in_flight";
    });
  }
  allocated(
    id: string,
    attemptId: string,
    index: number,
    value: { fileId: string; uploadUrl: string },
  ) {
    plain(value, ["fileId", "uploadUrl"]);
    const fileId = str(value.fileId, "file identity", 128),
      uploadUrl = str(value.uploadUrl, "upload capability", 4096);
    let url: URL;
    try {
      url = new URL(uploadUrl);
    } catch {
      conflict();
    }
    if (
      url.protocol !== "https:" ||
      url.hostname !== "files.slack.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !/^\/upload\/v1\/[A-Za-z0-9_-]+$/.test(url.pathname)
    )
      conflict();
    return this.change(id, attemptId, index, (e) => {
      if (e.allocation !== "in_flight" || e.fileId) conflict();
      e.allocation = "acknowledged";
      e.fileId = fileId;
      e.uploadUrl = uploadUrl;
    });
  }
  uploaded(id: string, attemptId: string, index: number) {
    return this.change(id, attemptId, index, (e) => {
      if (e.upload !== "in_flight") conflict();
      e.upload = "acknowledged";
    });
  }
  /** Public refusal and private phase refusal commit together. */
  reject(id: string, attemptId: string, index: number, phase: UploadPhase) {
    let rejected!: UploadJournalEntry;
    this.operations.reject(id, attemptId, index, () => {
      const e = this.get(id, attemptId, index);
      if (!e || e.attemptId !== attemptId) conflict();
      if (
        !["allocation", "upload", "share"].includes(phase) ||
        e[phase] !== "in_flight"
      )
        conflict();
      e[phase] = "rejected";
      e.rejectedAttemptId = attemptId;
      this.save(id, index, e);
      rejected = e;
    });
    return rejected;
  }
  /** operations.confirm owns the one transaction including this private write. */
  confirm(id: string, attemptId: string, index: number, receipt: string) {
    return this.operations.confirm(id, attemptId, index, receipt, () => {
      const e = this.get(id, attemptId, index);
      if (!e || e.attemptId !== attemptId || !e.fileId) conflict();
      if (e.receipt && e.receipt !== receipt) conflict();
      e.share = "acknowledged";
      e.receipt = receipt;
      delete e.uploadUrl;
      this.save(id, index, e);
    });
  }
  /** A persisted phase boundary proves no outstanding effect. Missing journals
   * provide no such proof for historical or alternate Slack adapters. */
  canResumeCheckpoint(id: string, attemptId: string, index: number): boolean {
    const parent = this.parent(id),
      operation = this.operations.list(id)[index];
    if (parent.target.platform !== "slack" || operation?.kind !== "attachment")
      return false;
    const e = this.get(id, attemptId, index);
    if (!e || e.attemptId !== attemptId || e.share === "acknowledged")
      return false;
    const phases = [e.allocation, e.upload, e.share];
    return (
      phases.every((state) =>
        ["pending", "acknowledged", "rejected"].includes(state),
      ) && phases.some((state) => state === "pending" || state === "rejected")
    );
  }
  /** Called within the parent's uncertainty transaction. */
  markUncertain(id: string) {
    const rows = this.db
      .prepare(
        "SELECT operation_index,data FROM external_delivery_uploads WHERE delivery_id=?",
      )
      .all(id);
    for (const row of rows) {
      const e = JSON.parse(row.data as string) as UploadJournalEntry;
      for (const phase of ["allocation", "upload", "share"] as const)
        if (e[phase] === "in_flight") e[phase] = "uncertain";
      this.save(id, row.operation_index as number, e);
    }
  }
  assertWorkspaceAvailable(workspaceId: string) {
    str(workspaceId, "workspace", 128);
    const row = this.db
      .prepare(
        "SELECT until_ms FROM slack_workspace_pauses WHERE workspace_id=?",
      )
      .get(workspaceId);
    if (row && (row.until_ms === null || Number(row.until_ms) > this.now()))
      throw new RoutineError(
        "unavailable",
        "Slack workspace requires retry or operator attention",
      );
  }
  pauseWorkspace(workspaceId: string, retryAfterMs?: number) {
    str(workspaceId, "workspace", 128);
    const until =
      typeof retryAfterMs === "number" &&
      Number.isSafeInteger(retryAfterMs) &&
      retryAfterMs >= 0 &&
      retryAfterMs <= 86400000
        ? this.now() + retryAfterMs
        : null;
    this.atomic(() => {
      this.db
        .prepare(
          "INSERT INTO slack_workspace_pauses(workspace_id,until_ms) VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET until_ms=CASE WHEN until_ms IS NULL OR excluded.until_ms IS NULL THEN NULL ELSE MAX(until_ms,excluded.until_ms) END",
        )
        .run(workspaceId, until);
    });
  }
}
