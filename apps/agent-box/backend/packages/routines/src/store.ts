import {
  taskOutputManifest,
  type TaskOutputScope,
  type TaskOutputMetadata,
} from "@mindi/agent-runtime/task-outputs";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  RoutineError,
  invalid,
  plain,
  str,
  type Routine,
  type RoutineDestination,
  type RoutinePublication,
  type Occurrence,
  type CreateRoutine,
  type UpdateRoutine,
  type Page,
  type PageInput,
} from "./types.js";
import {
  RoutineDeliveryRegistry,
  normalizeDeliveryRouting,
  snapshotDeliveryTarget,
  type ResolvedDeliveryTarget,
} from "./delivery-registry.js";
import {
  RoutineDeliveryOutbox,
  enqueueExternalDeliveries,
  type RoutineDeliveryPlan,
} from "./external-delivery.js";
import { normalizeSchedule, nextRunAt } from "./schedule.js";
function conflict(message: string): never {
  throw new RoutineError("conflict", message);
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") invalid("Invalid boolean");
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    invalid("Invalid expectedRevision");
  return value as number;
}
function destination(value: unknown): RoutineDestination {
  plain(value, ["channelId", "branchId"]);
  return {
    channelId: str(value.channelId, "channelId"),
    ...(value.branchId === undefined
      ? {}
      : { branchId: str(value.branchId, "branchId") }),
  };
}
type Table = "routines" | "occurrences" | "publications";
export class RoutineStore {
  private db: DatabaseSync;
  readonly deliveries: RoutineDeliveryOutbox;
  private resolveDelivery: (routine: Routine) => ResolvedDeliveryTarget[];
  private closed = false;
  private readonly resolveTaskOutputs?: (
    occurrence: Occurrence,
  ) => { scope: TaskOutputScope; outputs: TaskOutputMetadata[] } | undefined;
  private now: () => number;
  private validateDestination?: (
    profileId: string,
    destination: RoutineDestination,
  ) => void;
  private validateTarget?: (profileId: string, boardId: string) => void;
  constructor({
    databasePath,
    now = Date.now,
    validateTarget,
    validateDestination,
    resolveTaskOutputs,
    resolveDelivery = (routine) =>
      new RoutineDeliveryRegistry([]).resolve(
        routine.profileId,
        routine.deliver!,
      ),
  }: {
    resolveTaskOutputs?: (
      occurrence: Occurrence,
    ) => { scope: TaskOutputScope; outputs: TaskOutputMetadata[] } | undefined;
    resolveDelivery?: (routine: Routine) => ResolvedDeliveryTarget[];
    databasePath: string;
    now?: () => number;
    validateDestination?: (
      profileId: string,
      destination: RoutineDestination,
    ) => void;
    validateTarget?: (profileId: string, boardId: string) => void;
  }) {
    this.now = now;
    this.resolveTaskOutputs = resolveTaskOutputs;
    this.resolveDelivery = resolveDelivery;
    this.validateTarget = validateTarget;
    this.validateDestination = validateDestination;
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;",
      );
      this.atomic(() => {
        const version = this.db.prepare("PRAGMA user_version").get()!
          .user_version;
        if (
          version !== 0 &&
          version !== 1 &&
          version !== 2 &&
          version !== 3 &&
          version !== 4
        )
          throw new RoutineError(
            "unavailable",
            "Unsupported routine schema version",
          );
        this.db
          .exec(`CREATE TABLE IF NOT EXISTS routines(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS occurrences(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,routine_id TEXT NOT NULL REFERENCES routines(id),data TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS one_open_occurrence ON occurrences(routine_id) WHERE json_extract(data,'$.state') IN ('queued','running','attention_required');
 CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,key));CREATE TABLE IF NOT EXISTS publications(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL REFERENCES occurrences(id),routine_id TEXT NOT NULL REFERENCES routines(id),data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS external_deliveries(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,occurrence_id TEXT NOT NULL REFERENCES occurrences(id),routine_id TEXT NOT NULL REFERENCES routines(id),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS external_delivery_claims(delivery_id TEXT NOT NULL REFERENCES external_deliveries(id),attempt_id TEXT NOT NULL,PRIMARY KEY(delivery_id,attempt_id));
CREATE TABLE IF NOT EXISTS external_delivery_uploads(delivery_id TEXT NOT NULL REFERENCES external_deliveries(id),operation_index INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(delivery_id,operation_index));
CREATE TABLE IF NOT EXISTS slack_workspace_pauses(workspace_id TEXT PRIMARY KEY,until_ms INTEGER);
CREATE TABLE IF NOT EXISTS external_delivery_operations(delivery_id TEXT PRIMARY KEY REFERENCES external_deliveries(id),data TEXT NOT NULL);
PRAGMA user_version=4;`);
      });
      this.deliveries = new RoutineDeliveryOutbox(
        this.db,
        () => this.check(),
        (run) => this.atomic(run),
        this.now,
        (scope, key, input, run) => this.idempotent(scope, key, input, run),
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  private check() {
    if (this.closed)
      throw new RoutineError("closed", "Routine store is closed");
  }
  private atomic<T>(run: () => T): T {
    this.check();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private read<T>(table: Table, id: string): T {
    this.check();
    str(id, "id");
    const row = this.db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new RoutineError("not_found", `${table} not found`);
    return JSON.parse(row.data as string) as T;
  }
  private save<T extends { id: string }>(table: Table, value: T): T {
    this.db
      .prepare(`UPDATE ${table} SET data=? WHERE id=?`)
      .run(JSON.stringify(value), value.id);
    return value;
  }
  private idempotent<T>(
    scope: string,
    key: string,
    input: unknown,
    run: () => T,
  ): T {
    str(key, "idempotencyKey");
    const identity = JSON.stringify(input);
    const prior = this.db
      .prepare("SELECT input,result FROM idempotency WHERE scope=? AND key=?")
      .get(scope, key);
    if (prior) {
      if (prior.input !== identity) conflict("Idempotency conflict");
      return JSON.parse(prior.result as string) as T;
    }
    const result = run();
    this.db
      .prepare(
        "INSERT INTO idempotency(scope,key,input,result) VALUES(?,?,?,?)",
      )
      .run(scope, key, identity, JSON.stringify(result));
    return result;
  }
  create(input: CreateRoutine): Routine {
    plain(input, [
      "name",
      "prompt",
      "profileId",
      "boardId",
      "schedule",
      "idempotencyKey",
      "enabled",
      "destination",
      "deliver",
    ]);
    const normalized = {
      ...(input.deliver == null
        ? {}
        : { deliver: normalizeDeliveryRouting(input.deliver) }),
      name: str(input.name, "name"),
      prompt: str(input.prompt, "prompt", 50000),
      profileId: str(input.profileId, "profileId"),
      boardId: str(input.boardId, "boardId"),
      schedule: normalizeSchedule(input.schedule),
      enabled: input.enabled === undefined ? true : bool(input.enabled),
      ...(input.destination == null
        ? {}
        : { destination: destination(input.destination) }),
    };
    return this.atomic(() =>
      this.idempotent("create", input.idempotencyKey, normalized, () => {
        this.validateTarget?.(normalized.profileId, normalized.boardId);
        if (normalized.destination)
          this.validateDestination?.(
            normalized.profileId,
            normalized.destination,
          );
        const now = this.now();
        const routine: Routine = {
          id: randomUUID(),
          ...normalized,
          deleted: false,
          revision: 1,
          createdAt: new Date(now).toISOString(),
          nextRunAt: nextRunAt(normalized.schedule, now),
        };
        this.db
          .prepare("INSERT INTO routines(id,data) VALUES(?,?)")
          .run(routine.id, JSON.stringify(routine));
        return routine;
      }),
    );
  }
  get(id: string): Routine {
    return this.read("routines", id);
  }
  update(id: string, input: UpdateRoutine): Routine {
    plain(input, [
      "expectedRevision",
      "name",
      "prompt",
      "schedule",
      "enabled",
      "destination",
      "deliver",
      "deleted",
    ]);
    revision(input.expectedRevision);
    const patch: Partial<Routine> = {};
    if (input.deliver != null)
      patch.deliver = normalizeDeliveryRouting(input.deliver);
    if (input.destination != null)
      patch.destination = destination(input.destination);
    if (input.name !== undefined) patch.name = str(input.name, "name");
    if (input.prompt !== undefined)
      patch.prompt = str(input.prompt, "prompt", 50000);
    if (input.schedule !== undefined)
      patch.schedule = normalizeSchedule(input.schedule);
    if (input.enabled !== undefined) patch.enabled = bool(input.enabled);
    if (input.deleted !== undefined) patch.deleted = bool(input.deleted);
    return this.atomic(() => {
      const routine = this.get(id);
      if (routine.revision !== input.expectedRevision)
        conflict("Revision conflict");
      if (routine.deleted) conflict("Routine is deleted");
      if (
        patch.prompt !== undefined ||
        patch.schedule !== undefined ||
        patch.enabled === true
      )
        this.validateTarget?.(routine.profileId, routine.boardId);
      const nextDestination =
        input.destination === null
          ? undefined
          : (patch.destination ?? routine.destination);
      if (
        nextDestination &&
        (input.destination !== undefined ||
          patch.prompt !== undefined ||
          patch.schedule !== undefined ||
          patch.enabled === true)
      )
        this.validateDestination?.(routine.profileId, nextDestination);
      if (input.destination === null) delete routine.destination;
      if (input.deliver === null) delete routine.deliver;
      if (patch.schedule)
        patch.nextRunAt = nextRunAt(patch.schedule, this.now());
      Object.assign(routine, patch);
      routine.revision++;
      return this.save("routines", routine);
    });
  }
  private page<T>(
    table: Table,
    scope: string,
    input: PageInput,
    where = "1=1",
    parameters: string[] = [],
  ): Page<T> {
    this.check();
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      invalid("Invalid page limit");
    let after = 0;
    if (input.after !== undefined) {
      str(input.after, "cursor", 1000);
      try {
        const value: unknown = JSON.parse(
          Buffer.from(input.after, "base64url").toString(),
        );
        if (
          !Array.isArray(value) ||
          value.length !== 2 ||
          value[0] !== scope ||
          !Number.isSafeInteger(value[1]) ||
          value[1] < 1
        )
          invalid("Invalid cursor");
        after = value[1] as number;
      } catch {
        invalid("Invalid cursor");
      }
    }
    const rows = this.db
      .prepare(
        `SELECT seq,data FROM ${table} WHERE ${where} AND seq>? ORDER BY seq LIMIT ?`,
      )
      .all(...parameters, after, limit + 1);
    const visible = rows.slice(0, limit);
    return {
      items: visible.map((row) => JSON.parse(row.data as string) as T),
      ...(rows.length > limit
        ? {
            nextCursor: Buffer.from(
              JSON.stringify([scope, visible.at(-1)!.seq]),
            ).toString("base64url"),
          }
        : {}),
    };
  }
  list(input: PageInput & { includeDeleted?: boolean } = {}): Page<Routine> {
    plain(input, ["after", "limit", "includeDeleted"]);
    const include =
      input.includeDeleted === undefined ? false : bool(input.includeDeleted);
    return this.page(
      "routines",
      `routines:${include}`,
      input,
      include ? "1=1" : "json_extract(data,'$.deleted')=0",
    );
  }

  private open(routineId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT id FROM occurrences WHERE routine_id=? AND json_extract(data,'$.state') IN ('queued','running','attention_required')",
      )
      .get(routineId);
  }
  private deliveryPlan(routine: Routine): RoutineDeliveryPlan | undefined {
    if (routine.deliver === undefined) return;
    const base = {
      routing: routine.deliver,
      resolvedAt: new Date(this.now()).toISOString(),
    };
    try {
      const resolved = routine.deliver
        .split(",")
        .every((part) => part === "local")
        ? []
        : this.resolveDelivery(structuredClone(routine));
      if (!Array.isArray(resolved) || resolved.length > 64)
        invalid("Invalid resolved delivery targets");
      const targets = resolved.map(snapshotDeliveryTarget);
      const keys = targets.map((target) => JSON.stringify(target));
      if (new Set(keys).size !== keys.length)
        invalid("Duplicate resolved delivery targets");
      if (
        !targets.length &&
        routine.deliver.split(",").some((part) => part !== "local")
      )
        invalid("Unresolved delivery routing");
      return { ...base, state: "resolved", targets };
    } catch {
      return {
        ...base,
        state: "blocked",
        targets: [],
        reason: "Routine delivery targets are unavailable",
      };
    }
  }
  private occurrence(
    routine: Routine,
    source: Occurrence["source"],
    scheduledAt: number,
  ): Occurrence {
    if (this.open(routine.id))
      conflict("Routine already has an open occurrence");
    const occurrence: Occurrence = {
      id: randomUUID(),
      routineId: routine.id,
      source,
      scheduledAt,
      snapshot: routine,
      ...(routine.deliver === undefined
        ? {}
        : { deliveryPlan: this.deliveryPlan(routine) }),
      state: "queued",
      createdAt: new Date(this.now()).toISOString(),
    };
    this.db
      .prepare("INSERT INTO occurrences(id,routine_id,data) VALUES(?,?,?)")
      .run(occurrence.id, routine.id, JSON.stringify(occurrence));
    return occurrence;
  }
  trigger(
    id: string,
    input: { expectedRevision: number; idempotencyKey: string },
  ): Occurrence {
    str(id, "id");
    plain(input, ["expectedRevision", "idempotencyKey"]);
    revision(input.expectedRevision);
    return this.atomic(() =>
      this.idempotent(
        "trigger:" + id,
        input.idempotencyKey,
        { expectedRevision: input.expectedRevision },
        () => {
          const routine = this.get(id);
          if (routine.revision !== input.expectedRevision)
            conflict("Revision conflict");
          if (routine.deleted) conflict("Routine is deleted");
          this.validateTarget?.(routine.profileId, routine.boardId);
          return this.occurrence(routine, "manual", this.now());
        },
      ),
    );
  }
  enqueueDue(input: { limit?: number } = {}): Occurrence[] {
    plain(input, ["limit"]);
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      invalid("Invalid limit");
    return this.atomic(() => {
      const now = this.now();
      const rows = this.db
        .prepare(
          "SELECT data FROM routines r WHERE json_extract(data,'$.enabled')=1 AND json_extract(data,'$.deleted')=0 AND json_extract(data,'$.nextRunAt')<=? AND NOT EXISTS (SELECT 1 FROM occurrences o WHERE o.routine_id=r.id AND json_extract(o.data,'$.state') IN ('queued','running','attention_required')) ORDER BY json_extract(data,'$.nextRunAt'),seq LIMIT ?",
        )
        .all(now, limit);
      return rows.map((row) => {
        const routine = JSON.parse(row.data as string) as Routine;
        const occurrence = this.occurrence(
          routine,
          "scheduled",
          routine.nextRunAt!,
        );
        const updated = {
          ...routine,
          nextRunAt:
            routine.schedule.kind === "once"
              ? null
              : nextRunAt(routine.schedule, now, routine.nextRunAt!),
        };
        this.save("routines", updated);
        return occurrence;
      });
    });
  }
  getOccurrence(id: string): Occurrence {
    return this.read("occurrences", id);
  }
  listOccurrences(routineId: string, input: PageInput = {}): Page<Occurrence> {
    plain(input, ["after", "limit"]);
    this.get(routineId);
    return this.page(
      "occurrences",
      "occurrences:" + routineId,
      input,
      "routine_id=?",
      [routineId],
    );
  }
  listOpenOccurrences(input: PageInput = {}): Page<Occurrence> {
    plain(input, ["after", "limit"]);
    return this.page(
      "occurrences",
      "open",
      input,
      "json_extract(data,'$.state') IN ('queued','running','attention_required')",
    );
  }
  private bind(
    id: string,
    field: "taskId" | "attemptId",
    value: string,
  ): Occurrence {
    str(value, field);
    return this.atomic(() => {
      const occurrence = this.getOccurrence(id);
      if (occurrence[field] === value) return occurrence;
      if (occurrence[field] !== undefined) conflict("Binding conflict");
      if (
        occurrence.state !== "queued" &&
        occurrence.state !== "running" &&
        occurrence.state !== "attention_required"
      )
        conflict("Occurrence is terminal");
      occurrence[field] = value;
      if (field === "attemptId" && occurrence.state === "queued")
        occurrence.state = "running";
      return this.save("occurrences", occurrence);
    });
  }
  bindTask(id: string, taskId: string): Occurrence {
    return this.bind(id, "taskId", taskId);
  }
  bindAttempt(id: string, attemptId: string): Occurrence {
    return this.bind(id, "attemptId", attemptId);
  }
  advanceAttempt(
    id: string,
    input: { expectedAttemptId: string; attemptId: string },
  ): Occurrence {
    plain(input, ["expectedAttemptId", "attemptId"]);
    str(input.expectedAttemptId, "expectedAttemptId");
    str(input.attemptId, "attemptId");
    if (input.attemptId === input.expectedAttemptId)
      invalid("Retry requires a new attempt");
    return this.atomic(() => {
      const occurrence = this.getOccurrence(id);
      if (
        occurrence.attemptId === input.attemptId &&
        occurrence.priorAttemptIds?.at(-1) === input.expectedAttemptId
      )
        return occurrence;
      if (
        occurrence.state !== "running" ||
        !occurrence.taskId ||
        occurrence.attemptId !== input.expectedAttemptId ||
        occurrence.priorAttemptIds?.includes(input.attemptId)
      )
        conflict("Retry binding conflict");
      occurrence.priorAttemptIds = [
        ...(occurrence.priorAttemptIds ?? []),
        input.expectedAttemptId,
      ];
      occurrence.attemptId = input.attemptId;
      return this.save("occurrences", occurrence);
    });
  }
  finish(
    id: string,
    input: {
      state: "review" | "blocked" | "cancelled" | "attention_required";
      summary: string;
      outputs?: TaskOutputMetadata[];
    },
  ): Occurrence {
    plain(input, ["state", "summary", "outputs"]);
    if (
      !["review", "blocked", "cancelled", "attention_required"].includes(
        input.state,
      )
    )
      invalid("Invalid occurrence state");
    const summary =
      input.summary === "" && input.outputs !== undefined
        ? ""
        : str(input.summary, "summary", 10000);
    return this.atomic(() => {
      const occurrence = this.getOccurrence(id);
      let outputs: TaskOutputMetadata[] | undefined;
      const terminalOutput = ["review", "blocked"].includes(input.state);
      if (
        input.outputs !== undefined &&
        (!terminalOutput ||
          !occurrence.taskId ||
          !occurrence.attemptId ||
          !this.resolveTaskOutputs)
      )
        invalid("Routine output evidence is unavailable");
      if (
        terminalOutput &&
        occurrence.taskId &&
        occurrence.attemptId &&
        this.resolveTaskOutputs
      ) {
        try {
          const evidence = this.resolveTaskOutputs(structuredClone(occurrence));
          if (evidence === undefined) {
            if (input.outputs !== undefined) throw Error();
          } else {
            if (
              evidence.scope.profileId !== occurrence.snapshot.profileId ||
              evidence.scope.taskId !== occurrence.taskId ||
              evidence.scope.attemptId !== occurrence.attemptId
            )
              throw Error();
            const expected = taskOutputManifest(
              evidence.outputs,
              evidence.scope,
            );
            outputs = taskOutputManifest(input.outputs, evidence.scope);
            if (JSON.stringify(expected) !== JSON.stringify(outputs))
              throw Error();
          }
        } catch {
          invalid("Routine output manifest does not match its native attempt");
        }
      }
      if (
        occurrence.state === input.state &&
        occurrence.summary === summary &&
        JSON.stringify(occurrence.outputs ?? null) ===
          JSON.stringify(outputs ?? null)
      )
        return occurrence;
      if (
        !["queued", "running", "attention_required"].includes(occurrence.state)
      )
        conflict("Occurrence is terminal");
      occurrence.state = input.state;
      occurrence.summary = summary;
      if (outputs) occurrence.outputs = outputs;
      if (input.state !== "attention_required")
        occurrence.endedAt = new Date(this.now()).toISOString();
      this.save("occurrences", occurrence);
      if (occurrence.endedAt && occurrence.snapshot.destination) {
        const publication: RoutinePublication = {
          id: occurrence.id,
          occurrenceId: occurrence.id,
          routineId: occurrence.routineId,
          profileId: occurrence.snapshot.profileId,
          destination: occurrence.snapshot.destination,
          state: "pending",
          createdAt: occurrence.endedAt,
          updatedAt: occurrence.endedAt,
        };
        this.db
          .prepare("INSERT INTO publications(id,routine_id,data) VALUES(?,?,?)")
          .run(
            publication.id,
            publication.routineId,
            JSON.stringify(publication),
          );
      }
      enqueueExternalDeliveries(this.db, occurrence);
      return occurrence;
    });
  }
  getPublication(id: string): RoutinePublication | undefined {
    this.check();
    str(id, "id");
    const row = this.db
      .prepare("SELECT data FROM publications WHERE id=?")
      .get(id);
    return row
      ? (JSON.parse(row.data as string) as RoutinePublication)
      : undefined;
  }
  listPublications(
    input: PageInput & {
      routineId?: string;
      states?: RoutinePublication["state"][];
    } = {},
  ): Page<RoutinePublication> {
    plain(input, ["after", "limit", "routineId", "states"]);
    const states = input.states === undefined ? [] : input.states;
    if (
      !Array.isArray(states) ||
      states.length > 3 ||
      states.some(
        (state) => !["pending", "published", "blocked"].includes(state),
      )
    )
      invalid("Invalid publication states");
    const normalizedStates = [...new Set(states)].sort();
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (input.routineId !== undefined) {
      clauses.push("routine_id=?");
      parameters.push(str(input.routineId, "routineId"));
    }
    if (normalizedStates.length) {
      clauses.push(
        `json_extract(data,'$.state') IN (${normalizedStates.map(() => "?").join(",")})`,
      );
      parameters.push(...normalizedStates);
    }
    return this.page(
      "publications",
      JSON.stringify([
        "publications",
        input.routineId ?? null,
        normalizedStates,
      ]),
      input,
      clauses.join(" AND ") || "1=1",
      parameters,
    );
  }
  markPublished(id: string, messageId: string): RoutinePublication {
    str(messageId, "messageId");
    return this.atomic(() => {
      const publication = this.read<RoutinePublication>("publications", id);
      if (publication.state === "published") {
        if (publication.messageId !== messageId)
          conflict("Publication message conflict");
        return publication;
      }
      if (publication.state !== "pending")
        conflict("Publication is not pending");
      const occurrence = this.getOccurrence(publication.occurrenceId);
      if (!["review", "blocked", "cancelled"].includes(occurrence.state))
        conflict("Occurrence is not terminal");
      publication.state = "published";
      publication.messageId = messageId;
      publication.updatedAt = new Date(this.now()).toISOString();
      delete publication.reason;
      return this.save("publications", publication);
    });
  }
  blockPublication(id: string, reason: string): RoutinePublication {
    str(reason, "reason", 10000);
    return this.atomic(() => {
      const publication = this.read<RoutinePublication>("publications", id);
      if (publication.state === "blocked" && publication.reason === reason)
        return publication;
      if (publication.state !== "pending")
        conflict("Publication is not pending");
      publication.state = "blocked";
      publication.reason = reason;
      publication.updatedAt = new Date(this.now()).toISOString();
      return this.save("publications", publication);
    });
  }
  retryPublication(id: string): RoutinePublication {
    return this.atomic(() => {
      const publication = this.read<RoutinePublication>("publications", id);
      if (publication.state === "pending") return publication;
      if (publication.state !== "blocked")
        conflict("Publication is not blocked");
      publication.state = "pending";
      delete publication.reason;
      publication.updatedAt = new Date(this.now()).toISOString();
      return this.save("publications", publication);
    });
  }
}
