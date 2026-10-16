import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Attempt, Board, Task } from "@mindi/tasks";
import { OmpWorker } from "@mindi/omp";
import { startApplication } from "./application.js";
if (process.env.MINDI_LIVE_ACCEPTANCE !== "1")
  throw new Error("Set MINDI_LIVE_ACCEPTANCE=1 for native task acceptance");
const root = await mkdtemp(join(tmpdir(), "mindi-task-acceptance-"));
const token = randomUUID() + randomUUID();
const model = process.env.MINDI_ACCEPTANCE_MODEL ?? "openai-codex/gpt-6-astra";
const config = {
  stateRoot: root,
  workspace: root,
  port: 0,
  profiles: [
    {
      id: "coder",
      instructions:
        "Execute assigned tasks exactly. Use task_result once as your final tool. Never guess file contents or report completion before the tool succeeds.",
      modelIds: [model],
      defaultModelId: model,
      tools: ["write", "ask_user"],
      approvalMode: "write" as const,
    },
  ],
};
const diagnostics: string[] = [];
const worker = new OmpWorker({
  cwd: root,
  stateRoot: root,
  onDiagnostic: (text) => diagnostics.push(text),
});
let app = await startApplication({ config, token, worker });
const evidence: Record<string, unknown> = { root, model };
console.log(`Evidence directory: ${root}`);
async function call<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(app.url + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, `HTTP ${response.status} ${path}`);
  return (await response.json()) as T;
}
async function until<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Native task acceptance timeout");
}
try {
  const board = await call<Board>("/boards", "POST", {
    name: "Native acceptance",
    idempotencyKey: "board",
  });
  const created = await call<Task>(`/boards/${board.id}/tasks`, "POST", {
    title: "Write acceptance file",
    body: "Use write to create acceptance.txt containing exactly MINDI_TASK_782. Then report outcome review with summary File written.",
    completionContract: "acceptance.txt contains exactly MINDI_TASK_782",
    assignee: "coder",
    idempotencyKey: "write",
  });
  const ready = await call<Task>(`/tasks/${created.id}/transition`, "POST", {
    expectedRevision: created.revision,
    status: "ready",
    reason: "Temporary local acceptance",
  });
  const attempt = await call<Attempt>(`/tasks/${created.id}/dispatch`, "POST", {
    expectedRevision: ready.revision,
    idempotencyKey: "dispatch-write",
  });
  evidence.attempt = attempt;
  const review = await until(
    () => call<Task>(`/tasks/${created.id}`),
    (task) => task.status !== "running",
  );
  evidence.afterExecution = review;
  assert.equal(review.status, "review");
  assert.equal(
    await readFile(join(root, "acceptance.txt"), "utf8"),
    "MINDI_TASK_782",
  );
  const done = await call<Task>(`/tasks/${created.id}/review`, "POST", {
    expectedRevision: review.revision,
    decision: "accept",
    reason: "Exact file independently read and checked",
  });
  assert.equal(done.status, "done");
  await app.close();
  app = await startApplication({ config, token, worker });
  assert.deepEqual(await call<Task>(`/tasks/${created.id}`), done);
  const replay = await call<Attempt>(`/tasks/${created.id}/dispatch`, "POST", {
    expectedRevision: ready.revision,
    idempotencyKey: "dispatch-write",
  });
  assert.equal(replay.id, attempt.id);
  assert.equal(replay.state, "review");
  evidence.restartReplay = true;
  console.log("Native write, review and restart replay passed");
  const pending = await call<Task>(`/boards/${board.id}/tasks`, "POST", {
    title: "Wait for operator",
    body: "Use ask_user to ask exactly Which test option? and wait. Only after a response report blocked. Do not write files.",
    assignee: "coder",
    idempotencyKey: "cancel",
  });
  await call<Task>(`/tasks/${pending.id}/transition`, "POST", {
    expectedRevision: pending.revision,
    status: "ready",
    reason: "Cancellation test",
  });
  const automatic = await call<Board>(`/boards/${board.id}`, "PATCH", {
    expectedRevision: board.revision,
    dispatchMode: "auto",
  });
  const admitted = await until(
    () => call<{ items: Attempt[] }>(`/tasks/${pending.id}/attempts`),
    (page) => page.items.length === 1 && Boolean(page.items[0]?.runId),
  );
  const waiting = admitted.items[0]!;
  await until(
    () => call<Array<{ state: string }>>(`/runs/${waiting.runId}/interactions`),
    (items) => items.some((item) => item.state === "pending"),
  );
  await call<Board>(`/boards/${board.id}`, "PATCH", {
    expectedRevision: automatic.revision,
    dispatchMode: "manual",
  });
  await until(
    () => call<{ phase: string }>(`/boards/${board.id}/dispatch`),
    (status) => status.phase === "paused",
  );
  assert.equal(
    (await call<{ state: string }>(`/runs/${waiting.runId}`)).state,
    "running",
  );
  evidence.automaticAdmissionAndManualDrain = true;
  console.log(
    "Native automatic admission and manual drain passed without stopping worker",
  );
  const cancelled = await call<Attempt>(
    `/attempts/${waiting.id}/cancel`,
    "POST",
    {},
  );
  assert.ok(cancelled.cancellationRequestedAt);
  const stopped = await until(
    () => call<Task>(`/tasks/${pending.id}`),
    (task) => task.status !== "running",
  );
  assert.equal(stopped.status, "blocked");
  const run = await call<{ state: string }>(`/runs/${waiting.runId}`);
  assert.equal(run.state, "cancelled");
  evidence.cancelledAttempt = waiting.id;
  evidence.passed = true;
  console.log("Native pending-interaction cancellation passed");
} finally {
  await app.close();
  evidence.diagnostics = diagnostics;
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
}
