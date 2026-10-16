import { createHash } from "node:crypto";
import type { DesktopService } from "./service.js";
import { DesktopError } from "./settings.js";
import { bindDesktopRequest } from "./control/target.js";
import type { ControlLease } from "./control/control.js";

interface OperatorInput {
  leaseId: string;
  callId: string;
  action: string;
  input: Record<string, unknown>;
}
interface Generation {
  id: string;
  leaseId?: string;
  calls: Map<string, { signature: string; outcome: Promise<{ ok: true }> }>;
}
const owner = "operator";
function identity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new DesktopError("invalid");
}
function leaseView(lease: ControlLease) {
  return {
    leaseId: lease.id,
    phase: lease.phase,
    expiresInMs: Math.max(0, lease.expiresAt - performance.now()),
  };
}
/** Single authenticated backend principal. Every admission revalidates the live generation. */
export class DesktopOperator {
  private readonly generations = new Map<string, Generation>();
  constructor(private readonly desktops: DesktopService) {}
  private current(profileId: string, generation: string) {
    const { broker } = this.desktops.access(profileId, generation);
    let state = this.generations.get(profileId);
    if (!state || state.id !== generation) {
      state = { id: generation, calls: new Map() };
      this.generations.set(profileId, state);
    }
    return { broker, state };
  }
  status(profileId: string, generation: string) {
    const { broker } = this.current(profileId, generation);
    const status = broker.status();
    return {
      generation,
      lease: status.lease
        ? {
            phase: status.lease.phase,
            expiresInMs: Math.max(
              0,
              status.lease.expiresAt - performance.now(),
            ),
          }
        : null,
      input: status.input,
    };
  }
  acquire(profileId: string, generation: string) {
    const { broker, state } = this.current(profileId, generation);
    try {
      const lease = broker.acquire(owner);
      // Only new broker authority retires the old ledger. Repeated acquire
      // preserves accepted identities; uncertain input prevents a new lease.
      if (state.leaseId !== lease.id) state.calls.clear();
      state.leaseId = lease.id;
      return leaseView(lease);
    } catch {
      throw new DesktopError("conflict");
    }
  }
  heartbeat(profileId: string, generation: string, leaseId: string) {
    const { broker } = this.current(profileId, generation);
    identity(leaseId);
    try {
      return leaseView(broker.heartbeat(owner, leaseId));
    } catch {
      throw new DesktopError("conflict");
    }
  }
  release(profileId: string, generation: string, leaseId: string) {
    const { broker, state } = this.current(profileId, generation);
    identity(leaseId);
    try {
      broker.release(owner, leaseId);
      state.leaseId = undefined;
    } catch {
      throw new DesktopError("conflict");
    }
    return { ok: true as const };
  }
  async input(
    profileId: string,
    generation: string,
    request: OperatorInput,
  ): Promise<{ ok: true }> {
    const { broker, state } = this.current(profileId, generation);
    if (
      !request ||
      typeof request !== "object" ||
      Array.isArray(request) ||
      Object.keys(request).some(
        (key) => !["leaseId", "callId", "action", "input"].includes(key),
      )
    )
      throw new DesktopError("invalid");
    identity(request.leaseId);
    identity(request.callId);
    let args: Record<string, unknown>;
    try {
      if (request.action === "get_desktop_state")
        throw new Error("Mutation required");
      args = bindDesktopRequest(owner, request.action, request.input).args;
    } catch {
      throw new DesktopError("invalid");
    }
    if (
      state.leaseId !== request.leaseId ||
      broker.status().lease?.phase !== "held"
    )
      throw new DesktopError("conflict");
    const signature = createHash("sha256")
      .update(
        JSON.stringify([
          request.action,
          Object.keys(args)
            .sort()
            .map((key) => [key, args[key]]),
        ]),
      )
      .digest("hex");
    const key = `${request.leaseId}:${request.callId}`;
    const prior = state.calls.get(key);
    if (prior) {
      if (prior.signature !== signature) throw new DesktopError("conflict");
      return prior.outcome;
    }
    // Never evict an identity within an active lease: uncertainty cannot replay.
    if (state.calls.size >= 1024) throw new DesktopError("unavailable");
    const input = structuredClone(request.input);
    const outcome = broker
      .humanDesktopInput(owner, request.leaseId, request.action, input)
      .then(
        () => ({ ok: true as const }),
        () => {
          throw new DesktopError("unavailable");
        },
      );
    state.calls.set(key, { signature, outcome });
    return outcome;
  }
}
