import type { DatabaseSync } from "node:sqlite";
import type { RoutineExternalDelivery } from "./external-delivery.js";
import { RoutineError, invalid, plain, str } from "./types.js";

/** Provider-owned, deterministic payload; never credentials or live file bytes.
 * A dependent operation may refer to an earlier operation key, whose confirmed
 * receipt supplies the remote identity. The persisted payload never changes.
 */
export interface DeliveryOperationSpec {
  key: string;
  kind: "message" | "thread" | "attachment" | "conversation";
  payload: string;
}
export interface DeliveryOperation extends DeliveryOperationSpec {
  state: "pending" | "sending" | "confirmed" | "rejected" | "uncertain";
  attemptId?: string;
  receipt?: string;
}
function conflict(): never {
  throw new RoutineError("conflict", "Delivery operation conflicts");
}
function specs(
  value: readonly DeliveryOperationSpec[],
): DeliveryOperationSpec[] {
  if (!Array.isArray(value) || !value.length || value.length > 64)
    invalid("Invalid delivery operation plan");
  const keys = new Set<string>();
  const result = value.map((item): DeliveryOperationSpec => {
    plain(item, ["key", "kind", "payload"]);
    const key = str(item.key, "operation key", 128);
    if (keys.has(key)) invalid("Duplicate delivery operation key");
    keys.add(key);
    if (
      item.kind !== "message" &&
      item.kind !== "thread" &&
      item.kind !== "attachment" &&
      item.kind !== "conversation"
    )
      invalid("Invalid delivery operation kind");
    return {
      key,
      kind: item.kind,
      payload: str(item.payload, "operation payload", 20000),
    };
  });
  if (JSON.stringify(result).length > 128000)
    invalid("Delivery operation plan is too large");
  return result;
}
export class RoutineDeliveryOperations {
  constructor(
    private db: DatabaseSync,
    private parent: (id: string) => RoutineExternalDelivery,
    private atomic: <T>(run: () => T) => T,
  ) {}
  list(id: string): DeliveryOperation[] {
    this.parent(id);
    const row = this.db
      .prepare(
        "SELECT data FROM external_delivery_operations WHERE delivery_id=?",
      )
      .get(id);
    return row ? (JSON.parse(row.data as string) as DeliveryOperation[]) : [];
  }
  private save(id: string, operations: DeliveryOperation[]) {
    this.db
      .prepare(
        "INSERT INTO external_delivery_operations(delivery_id,data) VALUES(?,?) ON CONFLICT(delivery_id) DO UPDATE SET data=excluded.data",
      )
      .run(id, JSON.stringify(operations));
  }
  private admitted(id: string, attemptId: string, reconciliation = false) {
    str(attemptId, "delivery attempt");
    const delivery = this.parent(id);
    if (
      delivery.attemptId !== attemptId ||
      (delivery.state !== "sending" &&
        !(reconciliation && delivery.state === "uncertain"))
    )
      conflict();
  }
  prepare(
    id: string,
    attemptId: string,
    input: readonly DeliveryOperationSpec[],
  ): DeliveryOperation[] {
    const plan = specs(input);
    return this.atomic(() => {
      this.admitted(id, attemptId);
      const existing = this.list(id);
      if (existing.length) {
        const original = existing.map(({ key, kind, payload }) => ({
          key,
          kind,
          payload,
        }));
        if (JSON.stringify(original) !== JSON.stringify(plan)) conflict();
        return existing;
      }
      const operations: DeliveryOperation[] = plan.map((s) => ({
        ...s,
        state: "pending",
      }));
      this.save(id, operations);
      return operations;
    });
  }
  private change(
    id: string,
    attemptId: string,
    index: number,
    update: (
      operation: DeliveryOperation,
      earlier: DeliveryOperation[],
    ) => void,
    reconciliation = false,
  ): DeliveryOperation {
    if (!Number.isSafeInteger(index) || index < 0)
      invalid("Invalid operation index");
    return this.atomic(() => {
      this.admitted(id, attemptId, reconciliation);
      const operations = this.list(id),
        operation = operations[index];
      if (!operation) conflict();
      update(operation, operations.slice(0, index));
      this.save(id, operations);
      return operation;
    });
  }
  claim(
    id: string,
    attemptId: string,
    index: number,
    privateEffect?: () => void,
  ): DeliveryOperation {
    return this.change(id, attemptId, index, (operation, earlier) => {
      if (
        !earlier.every((p) => p.state === "confirmed") ||
        !["pending", "rejected"].includes(operation.state) ||
        operation.attemptId === attemptId
      )
        conflict();
      operation.state = "sending";
      operation.attemptId = attemptId;
      privateEffect?.();
    });
  }
  confirm(
    id: string,
    attemptId: string,
    index: number,
    receipt: string,
    privateEffect?: () => void,
  ): DeliveryOperation {
    str(receipt, "operation receipt", 1024);
    return this.change(
      id,
      attemptId,
      index,
      (operation) => {
        if (operation.attemptId !== attemptId) conflict();
        privateEffect?.();
        if (operation.state === "confirmed") {
          if (operation.receipt !== receipt) conflict();
          return;
        }
        if (!["sending", "uncertain"].includes(operation.state)) conflict();
        operation.state = "confirmed";
        operation.receipt = receipt;
      },
      true,
    );
  }
  reject(
    id: string,
    attemptId: string,
    index: number,
    privateEffect?: () => void,
  ): DeliveryOperation {
    return this.change(id, attemptId, index, (operation) => {
      if (operation.state !== "sending" || operation.attemptId !== attemptId)
        conflict();
      privateEffect?.();
      operation.state = "rejected";
    });
  }
  /** Outbox transaction hooks: these must share the parent state transaction. */
  assertComplete(id: string) {
    if (this.list(id).some((p) => p.state !== "confirmed")) conflict();
  }
  assertRetryable(id: string) {
    if (
      this.list(id).some(
        (p) => p.state === "sending" || p.state === "uncertain",
      )
    )
      conflict();
  }
  assertContinuable(id: string) {
    if (!canContinueOperations(this.list(id))) conflict();
  }
  markUncertain(id: string, canResume?: (index: number) => boolean) {
    const operations = this.list(id);
    if (!operations.some((p) => p.state === "sending")) return;
    for (const [index, operation] of operations.entries())
      if (operation.state === "sending")
        operation.state = canResume?.(index) ? "rejected" : "uncertain";
    this.save(id, operations);
  }
}

/** No unresolved admission may be replayed; fully confirmed plans need no sends. */
export function canContinueOperations(
  operations: readonly DeliveryOperation[],
): boolean {
  return (
    operations.some((p) => p.state === "pending" || p.state === "rejected") &&
    !operations.some((p) => p.state === "sending" || p.state === "uncertain")
  );
}
