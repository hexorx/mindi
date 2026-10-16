import { randomUUID } from "node:crypto";

export interface ObservationScope {
  owner: string;
  target: string;
}
export type InputKind = "agent" | "human" | "observation";
export interface InputPermit {
  id: string;
  kind: InputKind;
  generation: string;
  scope?: ObservationScope;
}
export interface ControlLease {
  id: string;
  owner: string;
  phase: "draining" | "held" | "releasing";
  expiresAt: number;
  generation: string;
}
interface Options {
  now?: () => number;
  id?: () => string;
  ttlMs?: number;
}

/**
 * In-process authority for one display. The broker, not an HTTP caller, owns
 * permits and completes them only when downstream execution is proven finished.
 * Caller timeout, disconnect and lease expiry NEVER complete an input permit.
 * Observation capabilities are bound to a trusted caller and exact target.
 * Public status omits lease and permit capabilities. Authenticate owner/scope at
 * the transport boundary; this class is never itself an authentication layer.
 */
export class DesktopControl {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly ttlMs: number;
  private readonly boot: string;
  private epoch = 0;
  private readonly observations = new Map<
    string,
    { generation: string; scope: ObservationScope }
  >();
  private lease: Omit<ControlLease, "generation"> | null = null;
  private input: InputPermit | null = null;

  constructor(options: Options = {}) {
    this.now = options.now || (() => performance.now());
    this.id = options.id || randomUUID;
    this.ttlMs = options.ttlMs ?? 15_000;
    if (!Number.isFinite(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 60_000)
      throw new Error("Control lease TTL must be between 1 and 60000 ms.");
    this.boot = this.id();
  }
  private get generation() {
    return `${this.boot}:${this.epoch}`;
  }
  private advanceGeneration() {
    this.epoch++;
    this.observations.clear();
  }
  private expire() {
    if (
      this.lease &&
      this.lease.phase !== "releasing" &&
      this.now() >= this.lease.expiresAt
    )
      this.startRelease();
  }
  private startRelease() {
    if (!this.lease || this.lease.phase === "releasing") return;
    this.advanceGeneration();
    this.lease.phase = "releasing";
    if (this.input?.kind !== "human") this.lease = null;
  }
  private snapshotLease(): ControlLease {
    if (!this.lease) throw new Error("Control lease is no longer active.");
    return { ...this.lease, generation: this.generation };
  }
  private owned(owner: string, id: string) {
    this.expire();
    if (!this.lease || this.lease.owner !== owner || this.lease.id !== id)
      throw new Error("Control lease owner or identity does not match.");
  }
  status() {
    this.expire();
    return {
      generation: this.generation,
      lease: this.lease
        ? {
            owner: this.lease.owner,
            phase: this.lease.phase,
            expiresAt: this.lease.expiresAt,
          }
        : null,
      input: this.input ? { kind: this.input.kind } : null,
    };
  }
  acquire(owner: string): ControlLease {
    this.expire();
    if (!owner.trim() || owner.length > 256)
      throw new Error("A bounded controller owner is required.");
    if (this.lease) {
      if (this.lease.owner !== owner || this.lease.phase === "releasing")
        throw new Error("Display is already owned or releasing control.");
      return this.snapshotLease();
    }
    this.advanceGeneration();
    this.lease = {
      id: this.id(),
      owner,
      phase: this.input ? "draining" : "held",
      expiresAt: this.now() + this.ttlMs,
    };
    return this.snapshotLease();
  }
  heartbeat(owner: string, id: string): ControlLease {
    this.owned(owner, id);
    if (this.lease!.phase === "releasing")
      throw new Error("Control lease is releasing.");
    this.lease!.expiresAt = this.now() + this.ttlMs;
    return this.snapshotLease();
  }
  release(owner: string, id: string): void {
    this.owned(owner, id);
    this.startRelease();
  }
  private begin(kind: InputKind, scope?: ObservationScope): InputPermit {
    if (this.input)
      throw new Error("Display input or observation is already active.");
    this.input = {
      id: this.id(),
      kind,
      generation: this.generation,
      ...(scope ? { scope: { ...scope } } : {}),
    };
    return { ...this.input, ...(scope ? { scope: { ...scope } } : {}) };
  }
  beginObservation(scope: ObservationScope): InputPermit {
    this.expire();
    if (this.lease)
      throw new Error(
        "Agent observation is paused while human control is active.",
      );
    if (
      !scope.owner ||
      !scope.target ||
      scope.owner.length > 256 ||
      scope.target.length > 256
    )
      throw new Error("A bounded observation owner and target are required.");
    return this.begin("observation", scope);
  }
  /** Call only after a successful screenshot/state response; failed reads mint no token. */
  completeObservation(id: string): string {
    this.expire();
    const permit = this.input;
    if (!permit || permit.id !== id || permit.kind !== "observation")
      throw new Error("Observation permit does not match.");
    const valid = !this.lease && permit.generation === this.generation;
    this.endInput(id);
    if (!valid)
      throw new Error(
        "Human control changed during capture; a fresh observation is required.",
      );
    const token = this.id();
    if (this.observations.size >= 4096) this.observations.clear();
    this.observations.set(token, {
      generation: this.generation,
      scope: { ...permit.scope! },
    });
    return token;
  }
  beginAgentInput(observation: string, scope: ObservationScope): InputPermit {
    this.expire();
    if (this.lease)
      throw new Error("Agent input is paused while human control is active.");
    if (this.input)
      throw new Error("Display input or observation is already active.");
    const recorded = this.observations.get(observation);
    if (
      recorded?.generation !== this.generation ||
      recorded.scope.owner !== scope.owner ||
      recorded.scope.target !== scope.target
    )
      throw new Error("A fresh observation is required before agent input.");
    this.observations.clear();
    return this.begin("agent", scope);
  }
  beginHumanInput(owner: string, id: string): InputPermit {
    this.owned(owner, id);
    if (this.lease!.phase !== "held")
      throw new Error("Human control has not finished draining input.");
    return this.begin("human");
  }
  /** Broker-only terminal completion, never timeout or client-disconnect cleanup. */
  endInput(id: string): void {
    this.expire();
    if (!this.input || this.input.id !== id) return;
    if (this.input.kind !== "observation") this.advanceGeneration();
    this.input = null;
    if (this.lease?.phase === "releasing") this.lease = null;
    else if (this.lease?.phase === "draining") this.lease.phase = "held";
  }
}
