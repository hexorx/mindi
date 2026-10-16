import {
  deliveryOutputReader,
  type DeliveryOutputReader,
  type DeliveryOutputResolver,
} from "./delivery-content.js";
import {
  uploadReader,
  uploadWriter,
  type DeliveryUploadReader,
  type DeliveryUploadWriter,
  operationReader,
  operationWriter,
  type DeliveryOperationReader,
  type DeliveryOperationWriter,
} from "./delivery-context.js";
export type {
  DeliveryOperationReader,
  DeliveryOperationWriter,
} from "./delivery-context.js";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { DeliveryBinding } from "./delivery-registry.js";
import type { RoutineExternalDelivery } from "./external-delivery.js";
import type { RoutineStore } from "./store.js";
import { RoutineError, invalid, plain, str } from "./types.js";
export type DeliveryReceipt = { state: "delivered"; receipt: string };
export interface RoutineDeliveryAdapter extends DeliveryBinding {
  supportsOutputs?: true;
  /** Return rejected only when the provider definitively did not accept output. */
  send: (
    delivery: RoutineExternalDelivery,
    signal: AbortSignal,
    operations?: DeliveryOperationWriter,
    outputs?: DeliveryOutputReader,
    uploads?: DeliveryUploadWriter,
  ) => Promise<DeliveryReceipt | { state: "rejected"; reason?: "empty_file" }>;
  /** Read-only receipt lookup for the original stable request key; never send. */
  reconcile?: (
    delivery: RoutineExternalDelivery,
    signal: AbortSignal,
    operations?: DeliveryOperationReader,
    uploads?: DeliveryUploadReader,
  ) => Promise<DeliveryReceipt | { state: "unknown" }>;
}
const unavailable = () =>
  new RoutineError(
    "unavailable",
    "Routine delivery publisher requires attention",
  );
function receipt(value: unknown): string | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("state" in value) ||
    value.state !== "delivered"
  )
    return;
  plain(value, ["state", "receipt"]);
  return str(
    (value as Record<string, unknown>).receipt,
    "delivery receipt",
    1024,
  );
}
/** Application ownership must be held before startup recovery and until close.
 * Recovery never makes an admitted send retryable, even if a previous adapter
 * cannot be proven stopped. Only exact positive receipts resolve uncertainty.
 */
export class RoutineDeliveryPublisher {
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private controller?: AbortController;
  private closed = false;
  private disposed = false;
  private fault = false;
  private recovered = false;
  private lastCompletedSweepAt?: number;
  private timeoutMs: number;
  constructor(
    private readonly options: {
      routines: RoutineStore;
      adapters: () => readonly RoutineDeliveryAdapter[];
      timeoutMs?: number;
      resolveOutput?: DeliveryOutputResolver;
    },
  ) {
    this.timeoutMs = options.timeoutMs ?? 15000;
    if (
      !Number.isSafeInteger(this.timeoutMs) ||
      this.timeoutMs < 10 ||
      this.timeoutMs > 60000
    )
      invalid("Invalid delivery timeout");
  }
  status() {
    return {
      phase: this.closed
        ? "stopped"
        : this.fault
          ? "attention_required"
          : this.active
            ? "publishing"
            : "idle",
    };
  }
  serviceObservation() {
    return {
      phase: this.closed
        ? ("stopped" as const)
        : this.fault
          ? ("attention_required" as const)
          : this.lastCompletedSweepAt === undefined
            ? ("unknown" as const)
            : ("ready" as const),
      lastCompletedSweepAt: this.lastCompletedSweepAt,
    };
  }
  start() {
    if (this.closed || this.fault || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
    this.timer.unref();
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    if (this.closed || this.fault) return Promise.resolve();
    this.active = Promise.resolve()
      .then(() => this.sweep())
      .then(() => {
        if (!this.closed && !this.fault) this.lastCompletedSweepAt = Date.now();
      })
      .catch(() => {
        this.fail();
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
  private fail() {
    this.fault = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
  private adapter(
    d: RoutineExternalDelivery,
  ): RoutineDeliveryAdapter | undefined {
    if (d.outputs !== undefined && !this.options.resolveOutput) return;
    const matches = this.options
      .adapters()
      .filter(
        (adapter) =>
          d.outputs === undefined || adapter.supportsOutputs === true,
      )
      .filter(
        (a) =>
          a.id === d.target.bindingId ||
          a.platform.toLowerCase() === d.target.platform,
      );
    if (matches.length !== 1) return;
    const a = matches[0]!;
    if (
      a.id !== d.target.bindingId ||
      a.platform.toLowerCase() !== d.target.platform ||
      a.revision !== d.target.bindingRevision ||
      !Array.isArray(a.profileIds) ||
      !a.profileIds.includes(d.profileId) ||
      typeof a.send !== "function"
    )
      return;
    // Snapshot callbacks before yielding. No mutable adapter receiver is exposed.
    return {
      ...a,
      profileIds: [...a.profileIds],
      send: a.send,
      reconcile: a.reconcile,
    };
  }
  private async recover() {
    let after: string | undefined;
    do {
      const page = this.options.routines.deliveries.list({
        states: ["sending"],
        ...(after ? { after } : {}),
      });
      for (const d of page.items) {
        if (this.closed) return;
        this.options.routines.deliveries.uncertain(d.id, d.attemptId!);
      }
      after = page.nextCursor;
      if (after) await setImmediate();
    } while (after);
    this.recovered = true;
  }
  private async sweep() {
    if (!this.recovered) await this.recover();
    let after: string | undefined;
    do {
      if (this.closed || this.fault) return;
      const page = this.options.routines.deliveries.list({
        states: ["pending"],
        ...(after ? { after } : {}),
      });
      for (const d of page.items) {
        if (this.closed || this.fault) return;
        if (d.outputs !== undefined && !this.options.resolveOutput) {
          this.options.routines.deliveries.block(
            d.id,
            "Routine attachment delivery is not yet supported",
            d.revision,
          );
          continue;
        }
        let adapter: RoutineDeliveryAdapter | undefined;
        try {
          adapter = this.adapter(d);
        } catch {
          adapter = undefined;
        }
        if (!adapter) {
          this.options.routines.deliveries.block(
            d.id,
            "Routine delivery binding is unavailable",
            d.revision,
          );
          continue;
        }
        const claimed = this.options.routines.deliveries.claim(
          d.id,
          randomUUID(),
          d.revision,
        );
        const send = adapter.send;
        const result = await this.invoke(
          (signal, guard) =>
            send(
              structuredClone(claimed),
              signal,
              operationWriter(
                this.options.routines.deliveries.operations,
                claimed.id,
                claimed.attemptId!,
                guard,
              ),
              claimed.outputs && this.options.resolveOutput
                ? deliveryOutputReader(
                    claimed,
                    this.options.resolveOutput,
                    guard,
                  )
                : undefined,
              uploadWriter(
                this.options.routines.deliveries.uploads,
                claimed.id,
                claimed.attemptId!,
                guard,
              ),
            ),
          claimed,
        );
        if (result.kind === "value") {
          let accepted: string | undefined;
          try {
            accepted = receipt(result.value);
          } catch {
            accepted = undefined;
          }
          if (accepted)
            this.options.routines.deliveries.confirm(
              d.id,
              claimed.attemptId!,
              accepted,
            );
          else if (
            result.value &&
            typeof result.value === "object" &&
            "state" in result.value &&
            result.value.state === "rejected"
          )
            this.options.routines.deliveries.reject(
              d.id,
              claimed.attemptId!,
              "reason" in result.value && result.value.reason === "empty_file"
                ? "The provider does not accept empty file uploads"
                : "Delivery was rejected by the provider",
            );
          else
            this.options.routines.deliveries.uncertain(
              d.id,
              claimed.attemptId!,
            );
        } else this.markUnknown(claimed);
      }
      after = page.nextCursor;
      if (after) await setImmediate();
    } while (after);
  }
  private markUnknown(d: RoutineExternalDelivery) {
    const current = this.options.routines.deliveries.get(d.id);
    if (current.state === "delivered" && current.attemptId === d.attemptId)
      return;
    this.options.routines.deliveries.uncertain(d.id, d.attemptId!);
  }
  private async invoke(
    run: (signal: AbortSignal, guard: () => void) => Promise<unknown>,
    d: RoutineExternalDelivery,
  ): Promise<{ kind: "value"; value: unknown } | { kind: "unknown" }> {
    if (this.closed) return { kind: "unknown" };
    const controller = new AbortController();
    this.controller = controller;
    let expired = false;
    let contextOpen = true;
    const guard = () => {
      if (!contextOpen || this.closed || controller.signal.aborted)
        throw unavailable();
      const current = this.options.routines.deliveries.get(d.id);
      if (current.attemptId !== d.attemptId || current.state !== d.state)
        throw unavailable();
      if (d.state === "sending" && !this.adapter(d)) throw unavailable();
    };
    let finishAbort!: () => void;
    const aborted = new Promise<{ kind: "unknown" }>((resolve) => {
      finishAbort = () => {
        expired = true;
        resolve({ kind: "unknown" });
      };
      controller.signal.addEventListener("abort", finishAbort, { once: true });
    });
    const timer = setTimeout(() => {
      this.fail();
      controller.abort();
    }, this.timeoutMs);
    const task = Promise.resolve()
      .then(() => {
        if (this.closed || controller.signal.aborted) return undefined;
        return run(controller.signal, guard);
      })
      .then(
        (value) => {
          if (expired && !this.disposed) {
            try {
              const accepted = receipt(value);
              if (accepted)
                this.options.routines.deliveries.confirm(
                  d.id,
                  d.attemptId!,
                  accepted,
                );
            } catch {
              this.fail();
            }
          }
          return { kind: "value" as const, value };
        },
        () => ({ kind: "unknown" as const }),
      );
    try {
      return await Promise.race([task, aborted]);
    } finally {
      contextOpen = false;
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", finishAbort);
      if (this.controller === controller) this.controller = undefined;
    }
  }
  continueOperations(
    id: string,
    input: { expectedRevision: number; idempotencyKey: string },
  ) {
    if (this.closed || this.fault || this.active) throw unavailable();
    const result = this.options.routines.deliveries.continueOperations(
      id,
      input,
    );
    void this.tick();
    return result;
  }
  retry(
    id: string,
    input: { expectedRevision: number; idempotencyKey: string },
  ) {
    if (this.closed || this.fault) throw unavailable();
    const result = this.options.routines.deliveries.retry(id, input);
    void this.tick();
    return result;
  }
  reconcile(
    id: string,
    input: { expectedRevision: number },
  ): Promise<RoutineExternalDelivery> {
    if (this.closed || this.fault || this.active) throw unavailable();
    plain(input, ["expectedRevision"]);
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    )
      invalid("Invalid delivery revision");
    const d = this.options.routines.deliveries.get(id);
    if (d.state !== "uncertain" || d.revision !== input.expectedRevision)
      throw new RoutineError(
        "conflict",
        "Delivery reconciliation state conflicts",
      );
    const adapter = this.adapter(d),
      lookup = adapter?.reconcile;
    if (!lookup)
      throw new RoutineError(
        "unavailable",
        "Receipt reconciliation is unavailable",
      );
    const result = Promise.resolve().then(async () => {
      const response = await this.invoke(
        (signal, guard) =>
          lookup(
            structuredClone(d),
            signal,
            operationReader(
              this.options.routines.deliveries.operations,
              d.id,
              d.attemptId!,
              guard,
            ),
            uploadReader(
              this.options.routines.deliveries.uploads,
              d.id,
              d.attemptId!,
              guard,
            ),
          ),
        d,
      );
      let accepted: string | undefined;
      try {
        if (response.kind === "value") accepted = receipt(response.value);
      } catch {
        accepted = undefined;
      }
      return accepted
        ? this.options.routines.deliveries.confirm(id, d.attemptId!, accepted)
        : this.options.routines.deliveries.get(id);
    });
    const settled = result.finally(() => {
      this.active = undefined;
    });
    this.active = settled.then(
      () => {},
      () => {
        this.fail();
      },
    );
    return settled;
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.active;
    this.disposed = true;
  }
}
