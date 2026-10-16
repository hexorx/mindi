import {
  ViewerHistory,
  type ViewerOwner,
  type ViewerEventKind,
} from "./viewer-history.js";
import { opendir } from "node:fs/promises";
import { RuntimeError } from "@mindi/agent-runtime";
import {
  HerdrSession,
  TranscriptStore,
  transcriptId,
  type HerdrOptions,
  type OwnedPane,
  type TranscriptProjection,
} from "@mindi/herdr";
interface AssociationReader {
  getRun(id: string): { threadId: string; state?: string };
  getThread(id: string): { id: string; profileId: string };
}
export type ViewerObservation =
  | { state: "disabled" | "closed" | "opening" | "uncertain" | "unavailable" }
  | { state: "open"; pane: OwnedPane }
  | { state: "uncertain"; closeRetry: true };
export interface DelegationOptions {
  transcriptDir: string;
  runtime: AssociationReader;
  herdr?: HerdrOptions;
}
/** Owns viewer receipts. The OMP extension remains the execution transcript's sole writer and ACP owner. */
export class DelegationService {
  private store: TranscriptStore;
  private history: ViewerHistory;
  private viewerOwners = new Map<string, ViewerOwner>();
  private closing?: Promise<void>;
  private session?: Promise<HerdrSession>;
  private owned?: HerdrSession;
  private viewers = new Map<string, Promise<OwnedPane>>();
  private observations = new Map<string, ViewerObservation>();
  private knownPanes = new Map<string, OwnedPane>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private watched = new Map<string, string>();
  private watchTimer?: NodeJS.Timeout;
  private watching = false;
  private watchFailed = false;
  private sessionLossRecorded = false;
  constructor(private options: DelegationOptions) {
    this.store = new TranscriptStore(options.transcriptDir);
    this.history = new ViewerHistory(options.transcriptDir + ".viewers.sqlite");
  }
  private record(owner: ViewerOwner, kind: ViewerEventKind, pane?: OwnedPane) {
    try {
      this.history.append(owner, kind, pane);
    } catch {
      throw new RuntimeError(
        "unavailable",
        "Viewer history could not be persisted",
      );
    }
  }
  async viewerHistory(id: string, after = 0, limit = 100) {
    const value = await this.projection(id);
    try {
      return this.history.read(
        { ...value.identity, profileId: value.profileId },
        after,
        limit,
      );
    } catch {
      throw new RuntimeError("unavailable", "Viewer history unavailable");
    }
  }
  async viewerActivity(after = 0, limit = 100) {
    try {
      return this.history.readActivity(after, limit);
    } catch {
      throw new RuntimeError("unavailable", "Viewer activity unavailable");
    }
  }
  private async cleanupWithHistory(
    owners: ViewerOwner[],
    work: () => Promise<boolean>,
  ) {
    let failure: unknown;
    const record = (kind: ViewerEventKind) => {
      for (const owner of owners) {
        try {
          this.record(owner, kind);
        } catch (error) {
          failure ??= error;
        }
      }
    };
    record("close_requested");
    try {
      record((await work()) ? "closed" : "close_uncertain");
    } catch (error) {
      failure ??= error;
      record("close_uncertain");
    }
    if (failure) throw failure;
  }
  private async closePane(id: string, pane: OwnedPane) {
    await this.cleanupWithHistory([this.viewerOwners.get(id)!], async () => {
      await this.owned!.closePane(pane.paneId);
      this.knownPanes.delete(id);
      this.viewers.delete(id);
      this.watched.delete(id);
      this.observations.delete(id);
      return true;
    });
  }
  private async projection(id: string): Promise<
    TranscriptProjection & {
      profileId: string;
      runState: string;
      observation: "observed" | "uncertain";
    }
  > {
    try {
      transcriptId(id);
    } catch {
      throw new RuntimeError("invalid", "Invalid delegation id");
    }
    let value: TranscriptProjection;
    try {
      value = await this.store.read(id);
    } catch {
      throw new RuntimeError(
        "unavailable",
        "Delegation transcript unavailable",
      );
    }
    let runState = "unknown";
    let profileId: string;
    try {
      const run = this.options.runtime.getRun(value.identity.runId),
        thread = this.options.runtime.getThread(value.identity.threadId);
      runState = run.state ?? "unknown";
      if (
        run.threadId !== value.identity.threadId ||
        thread.id !== run.threadId ||
        typeof thread.profileId !== "string" ||
        !thread.profileId.trim()
      )
        throw Error();
      profileId = thread.profileId;
    } catch {
      throw new RuntimeError("invalid", "Invalid delegation association");
    }
    const terminal = [
      "completed",
      "cancelled",
      "failed",
      "interrupted",
    ].includes(value.status);
    return {
      ...value,
      profileId,
      runState,
      observation:
        runState === "attention_required" ||
        (!terminal && runState !== "running")
          ? "uncertain"
          : "observed",
    };
  }
  async list(input: { limit?: number; after?: string } = {}) {
    const limit = input.limit ?? 50;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      Object.keys(input).some((k) => !["limit", "after"].includes(k))
    )
      throw new RuntimeError("invalid", "Invalid delegation page");
    if (input.after !== undefined) {
      try {
        transcriptId(input.after);
      } catch {
        throw new RuntimeError("invalid", "Invalid delegation page");
      }
    }
    const ids: string[] = [];
    try {
      const directory = await opendir(this.options.transcriptDir);
      let count = 0;
      for await (const entry of directory) {
        if (++count > 10000)
          throw new RuntimeError(
            "unavailable",
            "Delegation inventory exceeds limit",
          );
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const id = entry.name.slice(0, -6);
          try {
            transcriptId(id);
            ids.push(id);
          } catch {
            /* unrelated file */
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const remaining = ids
      .sort()
      .filter((id) => input.after === undefined || id > input.after);
    const selected = remaining.slice(0, limit);
    const items: Array<{
      id: string;
      runId: string;
      threadId: string;
      toolCallId: string;
      status: TranscriptProjection["status"];
      lastSeq: number;
      viewerEnabled: boolean;
      profileId: string;
      viewer: ViewerObservation;
      runState: string;
      observation: "observed" | "uncertain";
    }> = [];
    let unavailable = 0;
    for (const id of selected) {
      try {
        const value = await this.projection(id);
        items.push({
          ...value.identity,
          status: value.status,
          lastSeq: value.lastSeq,
          viewerEnabled: !!this.options.herdr,
          profileId: value.profileId,
          viewer: this.viewerObservation(id),
          runState: value.runState,
          observation: value.observation,
        });
      } catch {
        unavailable++;
      }
    }
    return {
      items,
      unavailable,
      nextCursor: remaining.length > limit ? selected.at(-1)! : null,
    };
  }
  async read(id: string, after = 0, limit = 100) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new RuntimeError("invalid", "Invalid delegation page");
    const value = await this.projection(id);
    const events: TranscriptProjection["events"] = [];
    let bytes = 0;
    for (const event of value.events) {
      if (event.seq <= after) continue;
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length >= limit || bytes + size > 256 * 1024) break;
      events.push(event);
      bytes += size;
    }
    const last = events.at(-1)?.seq ?? after;
    return {
      ...value,
      events,
      nextSeq: last < value.lastSeq ? last : null,
      viewerEnabled: !!this.options.herdr,
      viewer: this.viewerObservation(id),
    };
  }
  private viewerObservation(id: string): ViewerObservation {
    if (!this.options.herdr) return { state: "disabled" };
    if (
      this.closed ||
      this.watchFailed ||
      (this.owned && !this.owned.isAlive())
    )
      return { state: "unavailable" };
    const observed = this.observations.get(id);
    if (observed?.state === "open")
      return this.owned?.isAlive()
        ? { state: "open", pane: { ...observed.pane } }
        : { state: "unavailable" };
    if (
      observed?.state === "uncertain" &&
      this.owned?.isAlive() &&
      this.knownPanes.has(id)
    )
      return { state: "uncertain", closeRetry: true };
    return observed ?? { state: "closed" };
  }
  private serial<T>(work: () => Promise<T>) {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  openViewer(id: string): Promise<OwnedPane> {
    return this.serial(async () => {
      if (this.closed || this.watchFailed)
        throw new RuntimeError("unavailable", "Delegation service closed");
      const projection = await this.projection(id);
      const terminal = [
        "completed",
        "cancelled",
        "failed",
        "interrupted",
      ].includes(projection.status);
      if (!terminal && projection.observation === "uncertain")
        throw new RuntimeError(
          "unavailable",
          "Delegation owner requires attention before viewing",
        );
      if (!this.options.herdr)
        throw new RuntimeError("unavailable", "Herdr viewer disabled");
      const existing = this.viewers.get(id);
      if (existing) {
        if (!this.owned?.isAlive())
          throw new RuntimeError(
            "unavailable",
            "Owned Herdr server unavailable",
          );
        return existing;
      }
      if (this.viewers.size >= 32)
        throw new RuntimeError("unavailable", "Owned viewer limit reached");
      const owner = { ...projection.identity, profileId: projection.profileId };
      this.record(owner, "open_requested");
      this.viewerOwners.set(id, owner);
      this.session ??= HerdrSession.start(this.options.herdr).then(
        (session) => {
          this.owned = session;
          return session;
        },
      );
      this.observations.set(id, { state: "opening" });
      let paneWasCreated = false;
      const opening = this.session
        .then((session) => session.openPane(this.store, id))
        .then(async (pane) => {
          paneWasCreated = true;
          this.knownPanes.set(id, pane);
          try {
            this.record(owner, "opened", pane);
          } catch (error) {
            await this.closePane(id, pane);
            throw error;
          }
          this.observations.set(id, { state: "open", pane: { ...pane } });
          return pane;
        })
        .catch((error: unknown) => {
          if (paneWasCreated && !this.knownPanes.has(id))
            this.observations.delete(id);
          else this.observations.set(id, { state: "uncertain" });
          this.record(owner, "open_uncertain");
          throw error;
        });
      this.viewers.set(id, opening);
      this.watchOwners();
      const pane = await opening;
      if (!terminal) {
        this.watched.set(id, projection.identity.runId);
      }
      return pane;
    });
  }
  closeViewer(id: string): Promise<{ closed: true }> {
    return this.serial(async () => {
      try {
        transcriptId(id);
      } catch {
        throw new RuntimeError("invalid", "Invalid delegation id");
      }
      const pending = this.viewers.get(id);
      if (pending) {
        this.observations.set(id, { state: "uncertain" });
        const pane = this.knownPanes.get(id) ?? (await pending);
        await this.closePane(id, pane);
        this.viewers.delete(id);
        this.watched.delete(id);
      }
      this.observations.delete(id);
      return { closed: true };
    });
  }
  private watchOwners() {
    if (this.watchTimer) return;
    this.watchTimer = setInterval(() => {
      if (this.watching || this.closed) return;
      this.watching = true;
      void this.serial(async () => {
        try {
          if (
            this.owned &&
            !this.owned.isAlive() &&
            !this.sessionLossRecorded
          ) {
            for (const id of this.viewers.keys()) {
              this.record(this.viewerOwners.get(id)!, "session_unavailable");
            }
            this.sessionLossRecorded = true;
          }
          for (const [id, runId] of this.watched) {
            let running = false;
            try {
              running = this.options.runtime.getRun(runId).state === "running";
            } catch {
              /* unknown owner loses presentation authority */
            }
            if (running) continue;
            let terminal = false;
            try {
              terminal = [
                "completed",
                "cancelled",
                "failed",
                "interrupted",
              ].includes((await this.projection(id)).status);
            } catch {
              /* unavailable journal cannot retain working authority */
            }
            if (!terminal) {
              const pane = await this.viewers.get(id);
              if (pane) {
                this.observations.set(id, { state: "uncertain" });
                await this.closePane(id, pane);
                this.viewers.delete(id);
                this.observations.delete(id);
              }
            }
            this.watched.delete(id);
          }
          if (!this.viewers.size || this.sessionLossRecorded) {
            clearInterval(this.watchTimer);
            this.watchTimer = undefined;
          }
        } catch {
          this.watchFailed = true;
          clearInterval(this.watchTimer);
          this.watchTimer = undefined;
          await this.cleanupWithHistory(
            [...this.viewers.keys()].map((id) => this.viewerOwners.get(id)!),
            async () => {
              if (!this.owned) return false;
              await this.owned.close();
              return true;
            },
          );
        }
      })
        .finally(() => {
          this.watching = false;
        })
        .catch(() => {
          this.watchFailed = true;
        });
    }, 250);
    this.watchTimer.unref();
  }
  herdrStatus() {
    return {
      state:
        !this.options.herdr || this.closed || this.watchFailed
          ? ("unavailable" as const)
          : this.owned?.isAlive()
            ? ("ready" as const)
            : this.owned
              ? ("unavailable" as const)
              : ("unknown" as const),
      detail: this.watchFailed
        ? "Owned viewer observation failed"
        : !this.options.herdr
          ? "Disabled"
          : this.closed
            ? "Owned service closed"
            : this.owned?.isAlive()
              ? "Owned Herdr server process alive"
              : this.owned
                ? "Owned Herdr server exited"
                : "Configured; owned server has not been observed ready",
      observedAt: new Date().toISOString(),
    };
  }
  close() {
    this.closing ??= this.closeService();
    return this.closing;
  }
  private async closeService() {
    this.closed = true;
    clearInterval(this.watchTimer);
    await this.queue;
    const owners = [...this.viewers.keys()].map((id) =>
      this.viewerOwners.get(id)!,
    );
    try {
      await this.cleanupWithHistory(owners, async () => {
        const session = await this.session?.catch(() => undefined);
        if (!session) return false;
        await session.close();
        return true;
      });
    } finally {
      this.history.close();
    }
  }
}
