import { RoutineDeliveryUploadJournal } from "./delivery-upload-journal.js";
import type { TaskOutputMetadata } from "@mindi/agent-runtime/task-outputs";
import {
  RoutineDeliveryOperations,
  canContinueOperations,
  type DeliveryOperation,
} from "./delivery-operations.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ResolvedDeliveryTarget } from "./delivery-registry.js";
import {
  RoutineError,
  plain,
  str,
  invalid,
  type Occurrence,
  type Page,
  type PageInput,
} from "./types.js";

export interface RoutineDeliveryPlan {
  routing: string;
  resolvedAt: string;
  state: "resolved" | "blocked";
  targets: ResolvedDeliveryTarget[];
  reason?: string;
}
export interface RoutineExternalDelivery {
  outputs?: TaskOutputMetadata[];
  revision: number;
  id: string;
  requestKey: string;
  occurrenceId: string;
  routineId: string;
  profileId: string;
  target: ResolvedDeliveryTarget;
  summary: string;
  outcome: "review" | "blocked" | "cancelled";
  state: "pending" | "sending" | "delivered" | "blocked" | "uncertain";
  attemptId?: string;
  receipt?: string;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}
export interface RoutineDeliveryProgress {
  delivery: RoutineExternalDelivery;
  operations: (Pick<
    DeliveryOperation,
    "key" | "kind" | "state" | "attemptId" | "receipt"
  > & { index: number })[];
  continuable: boolean;
}
function conflict(): never {
  throw new RoutineError(
    "conflict",
    "External delivery state or attempt conflicts",
  );
}

/** Called inside RoutineStore's outcome transaction, never by a transport. */
export function enqueueExternalDeliveries(
  db: DatabaseSync,
  occurrence: Occurrence,
): void {
  if (!occurrence.endedAt || occurrence.deliveryPlan?.state !== "resolved")
    return;
  for (const target of occurrence.deliveryPlan.targets) {
    const id = randomUUID();
    const delivery: RoutineExternalDelivery = {
      revision: 1,
      id,
      requestKey: id,
      occurrenceId: occurrence.id,
      routineId: occurrence.routineId,
      profileId: occurrence.snapshot.profileId,
      target,
      summary: occurrence.summary!,
      ...(occurrence.outputs
        ? { outputs: structuredClone(occurrence.outputs) }
        : {}),
      outcome: occurrence.state as RoutineExternalDelivery["outcome"],
      state: "pending",
      createdAt: occurrence.endedAt,
      updatedAt: occurrence.endedAt,
    };
    db.prepare(
      "INSERT INTO external_deliveries(id,occurrence_id,routine_id,data) VALUES(?,?,?,?)",
    ).run(id, occurrence.id, occurrence.routineId, JSON.stringify(delivery));
  }
}
export class RoutineDeliveryOutbox {
  readonly operations: RoutineDeliveryOperations;
  readonly uploads: RoutineDeliveryUploadJournal;
  constructor(
    private db: DatabaseSync,
    private check: () => void,
    private atomic: <T>(run: () => T) => T,
    private now: () => number,
    private replay: <T>(
      scope: string,
      key: string,
      input: unknown,
      run: () => T,
    ) => T,
  ) {
    this.operations = new RoutineDeliveryOperations(
      db,
      (id) => this.get(id),
      atomic,
    );
    this.uploads = new RoutineDeliveryUploadJournal(
      db,
      (id) => this.get(id),
      this.operations,
      atomic,
      now,
    );
  }
  get(id: string): RoutineExternalDelivery {
    this.check();
    str(id, "delivery id");
    const row = this.db
      .prepare("SELECT data FROM external_deliveries WHERE id=?")
      .get(id);
    if (!row)
      throw new RoutineError("not_found", "External delivery not found");
    return JSON.parse(row.data as string) as RoutineExternalDelivery;
  }
  /** Public progress excludes provider payloads. Both reads are synchronous under
   * the application's exclusive store ownership, with no transport work here.
   */
  progress(id: string): RoutineDeliveryProgress {
    const delivery = this.get(id);
    const operations = this.operations.list(id);
    return {
      delivery,
      operations: operations.map(
        ({ key, kind, state, attemptId, receipt }, index) => ({
          index,
          key,
          kind,
          state,
          ...(attemptId === undefined ? {} : { attemptId }),
          ...(receipt === undefined ? {} : { receipt }),
        }),
      ),
      continuable:
        delivery.state === "uncertain" && canContinueOperations(operations),
    };
  }
  list(
    input: PageInput & {
      occurrenceId?: string;
      routineId?: string;
      states?: RoutineExternalDelivery["state"][];
    } = {},
  ): Page<RoutineExternalDelivery> {
    this.check();
    plain(input, ["after", "limit", "occurrenceId", "routineId", "states"]);
    const limit = input.limit === undefined ? 50 : input.limit;
    if (
      typeof limit !== "number" ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      invalid("Invalid delivery page limit");
    const states = input.states === undefined ? [] : input.states;
    if (
      !Array.isArray(states) ||
      states.length > 5 ||
      states.some(
        (s) =>
          !["pending", "sending", "delivered", "blocked", "uncertain"].includes(
            s,
          ),
      )
    )
      invalid("Invalid delivery states");
    const normalized = [...new Set(states)].sort();
    const scope = JSON.stringify([
      "external_deliveries",
      input.occurrenceId ?? null,
      input.routineId ?? null,
      normalized,
    ]);
    let after = 0;
    if (input.after !== undefined) {
      const cursorText = str(input.after, "cursor", 1000);
      try {
        const cursor: unknown = JSON.parse(
          Buffer.from(cursorText, "base64url").toString(),
        );
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 2 ||
          cursor[0] !== scope ||
          !Number.isSafeInteger(cursor[1]) ||
          cursor[1] < 1
        )
          invalid("Invalid delivery cursor");
        after = cursor[1] as number;
      } catch {
        invalid("Invalid delivery cursor");
      }
    }
    const clauses = ["seq>?"],
      parameters: (string | number)[] = [after];
    for (const [key, column] of [
      ["occurrenceId", "occurrence_id"],
      ["routineId", "routine_id"],
    ] as const)
      if (input[key] !== undefined) {
        clauses.push(`${column}=?`);
        parameters.push(str(input[key], key));
      }
    if (normalized.length) {
      clauses.push(
        `json_extract(data,'$.state') IN (${normalized.map(() => "?").join(",")})`,
      );
      parameters.push(...normalized);
    }
    const rows = this.db
      .prepare(
        `SELECT seq,data FROM external_deliveries WHERE ${clauses.join(" AND ")} ORDER BY seq LIMIT ?`,
      )
      .all(...parameters, limit + 1);
    const visible = rows.slice(0, limit);
    return {
      items: visible.map(
        (row) => JSON.parse(row.data as string) as RoutineExternalDelivery,
      ),
      ...(rows.length > limit
        ? {
            nextCursor: Buffer.from(
              JSON.stringify([scope, visible.at(-1)!.seq]),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  private change(
    id: string,
    update: (delivery: RoutineExternalDelivery) => void,
  ): RoutineExternalDelivery {
    return this.atomic(() => this.update(id, update));
  }
  private update(
    id: string,
    update: (delivery: RoutineExternalDelivery) => void,
  ): RoutineExternalDelivery {
    const delivery = this.get(id);
    const before = JSON.stringify(delivery);
    update(delivery);
    if (JSON.stringify(delivery) === before) return delivery;
    delivery.revision++;
    delivery.updatedAt = new Date(this.now()).toISOString();
    this.db
      .prepare("UPDATE external_deliveries SET data=? WHERE id=?")
      .run(JSON.stringify(delivery), id);
    return delivery;
  }
  claim(
    id: string,
    attemptId: string,
    expectedRevision: number,
  ): RoutineExternalDelivery {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      invalid("Invalid delivery revision");
    str(attemptId, "delivery attempt");
    return this.change(id, (d) => {
      if (d.state !== "pending" || d.revision !== expectedRevision) conflict();
      if (
        this.db
          .prepare(
            "SELECT 1 FROM external_delivery_claims WHERE delivery_id=? AND attempt_id=?",
          )
          .get(id, attemptId)
      )
        conflict();
      this.db
        .prepare(
          "INSERT INTO external_delivery_claims(delivery_id,attempt_id) VALUES(?,?)",
        )
        .run(id, attemptId);
      d.state = "sending";
      d.attemptId = attemptId;
      delete d.reason;
    });
  }
  confirm(
    id: string,
    attemptId: string,
    receipt: string,
  ): RoutineExternalDelivery {
    str(attemptId, "delivery attempt");
    str(receipt, "delivery receipt", 1024);
    return this.change(id, (d) => {
      if (d.attemptId !== attemptId) conflict();
      if (d.state === "delivered") {
        if (d.receipt !== receipt) conflict();
        return;
      }
      if (!["sending", "uncertain"].includes(d.state)) conflict();
      this.operations.assertComplete(id);
      d.state = "delivered";
      d.receipt = receipt;
      delete d.reason;
    });
  }
  uncertain(id: string, attemptId: string): RoutineExternalDelivery {
    str(attemptId, "delivery attempt");
    return this.change(id, (d) => {
      if (
        d.attemptId !== attemptId ||
        !["sending", "uncertain"].includes(d.state)
      )
        conflict();
      this.operations.markUncertain(id, (index) =>
        this.uploads.canResumeCheckpoint(id, attemptId, index),
      );
      this.uploads.markUncertain(id);
      d.state = "uncertain";
      d.reason = "Delivery outcome requires reconciliation";
    });
  }
  block(
    id: string,
    reason: string,
    expectedRevision: number,
  ): RoutineExternalDelivery {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      invalid("Invalid delivery revision");
    str(reason, "delivery reason", 1000);
    return this.change(id, (d) => {
      if (d.state !== "pending" || d.revision !== expectedRevision) conflict();
      d.state = "blocked";
      d.reason = reason;
    });
  }
  /** Only a definitive adapter rejection, never a timeout or lost response. */
  reject(
    id: string,
    attemptId: string,
    reason: string,
  ): RoutineExternalDelivery {
    str(attemptId, "delivery attempt");
    str(reason, "delivery reason", 1000);
    return this.change(id, (d) => {
      if (d.state !== "sending" || d.attemptId !== attemptId) conflict();
      this.operations.assertRetryable(id);
      d.state = "blocked";
      d.reason = reason;
    });
  }
  /** Explicit continuation after operation reconciliation. This is separate from
   * retry: an uncertain legacy delivery without a proven plan cannot resume.
   * Receipt lookup never calls this mutation. The caller must inspect the exact
   * current parent revision, and every admitted operation must be resolved.
   */
  continueOperations(
    id: string,
    input: { expectedRevision: number; idempotencyKey: string },
  ): RoutineExternalDelivery {
    str(id, "delivery id");
    plain(input, ["expectedRevision", "idempotencyKey"]);
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1
    )
      invalid("Invalid delivery revision");
    const key = str(input.idempotencyKey, "idempotencyKey");
    return this.atomic(() =>
      this.replay(
        "external-delivery-continue:" + id,
        key,
        { expectedRevision: input.expectedRevision },
        () =>
          this.update(id, (d) => {
            if (
              d.state !== "uncertain" ||
              d.revision !== input.expectedRevision
            )
              conflict();
            this.operations.assertContinuable(id);
            d.state = "pending";
            delete d.attemptId;
            delete d.reason;
          }),
      ),
    );
  }
  retry(
    id: string,
    input: { expectedRevision: number; idempotencyKey: string },
  ): RoutineExternalDelivery {
    str(id, "delivery id");
    plain(input, ["expectedRevision", "idempotencyKey"]);
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      (input.expectedRevision as number) < 1
    )
      invalid("Invalid delivery revision");
    const key = str(input.idempotencyKey, "idempotencyKey");
    return this.atomic(() =>
      this.replay(
        "external-delivery-retry:" + id,
        key,
        { expectedRevision: input.expectedRevision },
        () =>
          this.update(id, (d) => {
            if (d.state !== "blocked" || d.revision !== input.expectedRevision)
              conflict();
            d.state = "pending";
            delete d.attemptId;
            delete d.reason;
          }),
      ),
    );
  }
}
