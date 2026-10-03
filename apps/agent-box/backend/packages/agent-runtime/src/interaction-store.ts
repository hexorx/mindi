import {
  InteractionHistory,
  type InteractionHistoryInput,
} from "./interaction-history.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  RuntimeError,
  type Interaction,
  type InteractionRequest,
  type InteractionResponse,
  type RunEventData,
} from "./types.js";

function exactObject(
  value: unknown,
  required: string[],
  optional: string[] = [],
): boolean {
  if (
    !value ||
    typeof value !== "object" ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    return false;
  const keys = Reflect.ownKeys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      return (
        typeof key === "string" &&
        (required.includes(key) || optional.includes(key)) &&
        "value" in descriptor &&
        descriptor.enumerable
      );
    })
  );
}
function exactArray(value: unknown, allowEmpty = false): value is unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    (!allowEmpty && value.length === 0) ||
    value.length > 32
  )
    return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === value.length + 1 &&
    keys.every(
      (key) =>
        key === "length" ||
        (typeof key === "string" &&
          /^(0|[1-9][0-9]*)$/.test(key) &&
          Number(key) < value.length &&
          "value" in Object.getOwnPropertyDescriptor(value, key)! &&
          Object.getOwnPropertyDescriptor(value, key)!.enumerable),
    )
  );
}
function boundedString(value: unknown, bytes: number): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    Buffer.byteLength(value) <= bytes
  );
}
export function validateInteractionRequest(request: InteractionRequest): void {
  if (
    !exactObject(
      request,
      ["kind", "prompt"],
      [
        "choices",
        "maxLength",
        "timeoutMs",
        "multiple",
        "allowCustom",
        "source",
      ],
    ) ||
    !boundedString(request.prompt, 16384) ||
    (request.timeoutMs !== undefined &&
      (!Number.isSafeInteger(request.timeoutMs) ||
        request.timeoutMs <= 0 ||
        request.timeoutMs > 1800000))
  )
    throw new RuntimeError("invalid", "Invalid interaction request");
  if (request.source !== undefined) {
    const formats = {
      "acp-permission": ["choice"],
      "coordinator-tool-approval": ["choice"],
      "coordinator-question": ["choice", "text"],
      "omp-confirm": ["choice"],
      "omp-select": ["choice"],
      "omp-input": ["text"],
      "omp-editor": ["text"],
      "omp-question": ["question", "text"],
    };
    if (
      typeof request.source !== "string" ||
      !Object.hasOwn(formats, request.source) ||
      !formats[request.source].includes(request.kind)
    )
      throw new RuntimeError("invalid", "Invalid interaction source");
  }
  if (request.kind === "choice" || request.kind === "question") {
    if (
      !exactObject(
        request,
        [
          "kind",
          "prompt",
          "choices",
          ...(request.kind === "question" ? ["multiple", "allowCustom"] : []),
        ],
        ["timeoutMs", "source"],
      ) ||
      (request.kind === "question" &&
        (typeof request.multiple !== "boolean" ||
          typeof request.allowCustom !== "boolean")) ||
      !exactArray(request.choices) ||
      request.choices.some(
        (choice) =>
          !exactObject(choice, ["id", "label"]) ||
          !boundedString(choice.id, 128) ||
          !boundedString(choice.label, 1024),
      ) ||
      new Set(request.choices.map((choice) => choice.id)).size !==
        request.choices.length
    )
      throw new RuntimeError("invalid", "Invalid interaction choices");
  } else if (
    request.kind !== "text" ||
    !exactObject(
      request,
      ["kind", "prompt"],
      ["maxLength", "timeoutMs", "source"],
    ) ||
    (request.maxLength !== undefined &&
      (!Number.isSafeInteger(request.maxLength) ||
        request.maxLength <= 0 ||
        request.maxLength > 16384))
  ) {
    throw new RuntimeError("invalid", "Invalid interaction text limit");
  }
}
export function validateInteractionResponse(
  request: InteractionRequest,
  response: InteractionResponse,
): void {
  if (
    request.kind === "question" &&
    exactObject(response, ["choiceIds"], ["text"]) &&
    "choiceIds" in response
  ) {
    const ids = response.choiceIds;
    const hasText = Object.hasOwn(response, "text");
    if (
      exactArray(ids, true) &&
      ids.every(
        (id) =>
          typeof id === "string" &&
          request.choices.some((choice) => choice.id === id),
      ) &&
      new Set(ids).size === ids.length &&
      (!hasText ||
        (request.allowCustom && boundedString(response.text, 4096))) &&
      ids.length + Number(hasText) > 0 &&
      (request.multiple || ids.length + Number(hasText) === 1)
    )
      return;
  }
  if (
    exactObject(response, [], ["cancelled", "choiceId", "text"]) &&
    Object.keys(response).length === 1
  ) {
    if ("cancelled" in response && response.cancelled === true) return;
    if (
      request.kind === "choice" &&
      "choiceId" in response &&
      request.choices.some((choice) => choice.id === response.choiceId)
    )
      return;
    if (
      request.kind === "text" &&
      "text" in response &&
      typeof response.text === "string" &&
      response.text.length <= (request.maxLength ?? 4096)
    )
      return;
  }
  throw new RuntimeError("invalid", "Invalid interaction response");
}
interface Waiter {
  resolve: (response: InteractionResponse) => void;
  cleanup: () => void;
}
function responseIdentity(
  response: InteractionResponse | undefined,
): string | undefined {
  if (response && "choiceIds" in response)
    return JSON.stringify({
      choiceIds: response.choiceIds,
      ...(Object.hasOwn(response, "text") ? { text: response.text } : {}),
    });
  return JSON.stringify(response);
}
export class InteractionStore {
  private readonly history: InteractionHistory;
  private readonly waiting = new Map<string, Waiter>();
  constructor(
    private readonly db: DatabaseSync,
    private readonly transaction: <T>(operation: () => T) => T,
    private readonly append: (runId: string, event: RunEventData) => void,
    private readonly storageFailure: () => void,
  ) {
    this.history = new InteractionHistory(db);
  }
  migrate(legacyHistory: boolean) {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS interactions (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), value TEXT NOT NULL) STRICT; CREATE INDEX IF NOT EXISTS interactions_run ON interactions(run_id); PRAGMA user_version=3;",
    );
    this.history.migrate(legacyHistory);
  }
  currentHistory() {
    return this.history.current();
  }
  pageHistory(input: InteractionHistoryInput = {}) {
    return this.history.page(input);
  }
  recover(): void {
    // Called inside the owner acquisition transaction; no old waiter is revived.
    for (const row of this.db
      .prepare(
        "SELECT value FROM interactions WHERE json_extract(value, '$.state')='pending'",
      )
      .all()) {
      const item = JSON.parse(String(row.value)) as Interaction;
      item.state = "interrupted";
      delete item.response;
      this.save(item);
    }
  }
  failClosed(): void {
    for (const waiter of this.waiting.values()) {
      waiter.cleanup();
      waiter.resolve({ cancelled: true });
    }
    this.waiting.clear();
  }
  private access<T>(operation: () => T): T {
    try {
      return operation();
    } catch {
      this.failClosed();
      this.storageFailure();
      throw new RuntimeError(
        "unavailable",
        "Runtime storage requires recovery",
      );
    }
  }
  private persist<T>(operation: () => T): T {
    return this.access(() => this.transaction(operation));
  }
  list(runId: string): Interaction[] {
    return this.access(() =>
      this.db
        .prepare("SELECT value FROM interactions WHERE run_id=? ORDER BY rowid")
        .all(runId)
        .map((row) => JSON.parse(String(row.value)) as Interaction),
    );
  }
  request(
    runId: string,
    request: InteractionRequest,
    signal?: AbortSignal,
  ): Promise<InteractionResponse> {
    validateInteractionRequest(request);
    if (signal?.aborted) return Promise.resolve({ cancelled: true });
    const previous = this.list(runId);
    if (
      previous.length >= 32 ||
      previous.filter((item) => item.state === "pending").length >= 8
    )
      throw new RuntimeError("invalid", "Interaction request limit exceeded");
    const now = Date.now();
    const interaction: Interaction = {
      id: randomUUID(),
      runId,
      request: structuredClone(request),
      state: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + (request.timeoutMs ?? 300000)).toISOString(),
    };
    this.persist(() => {
      this.db
        .prepare("INSERT INTO interactions(id,run_id,value) VALUES (?,?,?)")
        .run(interaction.id, runId, JSON.stringify(interaction));
      this.history.append(interaction);
      this.append(runId, { type: "interaction", interaction });
    });
    return new Promise((resolve) => {
      const settle = (state: "cancelled" | "expired") => {
        try {
          this.finish(interaction, state);
        } catch {
          // persist has already failed closed and aborted the owning runtime.
        }
      };
      const cancel = () => settle("cancelled");
      const timer = setTimeout(
        () => settle("expired"),
        request.timeoutMs ?? 300000,
      );
      timer.unref();
      signal?.addEventListener("abort", cancel, { once: true });
      this.waiting.set(interaction.id, {
        resolve,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
        },
      });
    });
  }
  private save(interaction: Interaction) {
    this.db
      .prepare("UPDATE interactions SET value=? WHERE id=?")
      .run(JSON.stringify(interaction), interaction.id);
    this.history.append(interaction);
    this.append(interaction.runId, { type: "interaction", interaction });
  }
  private wake(interaction: Interaction) {
    const waiter = this.waiting.get(interaction.id);
    this.waiting.delete(interaction.id);
    waiter?.cleanup();
    waiter?.resolve(
      structuredClone(interaction.response ?? { cancelled: true }),
    );
  }
  private finish(
    interaction: Interaction,
    state: Interaction["state"],
    response?: InteractionResponse,
  ): Interaction {
    interaction.state = state;
    if (response !== undefined)
      interaction.response = structuredClone(response);
    else delete interaction.response;
    this.persist(() => this.save(interaction));
    this.wake(interaction);
    return interaction;
  }
  settleRun(runId: string): void {
    const pending = this.list(runId).filter((item) => item.state === "pending");
    this.persist(() => {
      for (const item of pending) {
        item.state = "cancelled";
        delete item.response;
        this.save(item);
      }
    });
    for (const item of pending) this.wake(item);
  }
  respond(
    runId: string,
    id: string,
    response: InteractionResponse,
    active: boolean,
  ): Interaction {
    const interaction = this.list(runId).find((item) => item.id === id);
    if (!interaction)
      throw new RuntimeError("not_found", "Unknown interaction");
    validateInteractionResponse(interaction.request, response);
    if (
      (interaction.state === "answered" ||
        (interaction.state === "cancelled" &&
          interaction.response !== undefined)) &&
      responseIdentity(interaction.response) === responseIdentity(response)
    )
      return interaction;
    if (!active) throw new RuntimeError("conflict", "Run is not active");
    if (interaction.state !== "pending")
      throw new RuntimeError("conflict", "Interaction already resolved");
    if (Date.now() >= Date.parse(interaction.expiresAt)) {
      this.finish(interaction, "expired");
      throw new RuntimeError("conflict", "Interaction expired");
    }
    return this.finish(
      interaction,
      "cancelled" in response ? "cancelled" : "answered",
      response,
    );
  }
}
