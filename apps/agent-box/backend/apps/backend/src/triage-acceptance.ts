import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TASK_TOOLS } from "@mindi/agent-tools";
import type { Run } from "@mindi/agent-runtime";
import type { Page, Task, Attempt, Board } from "@mindi/tasks";
import { startApplication } from "./application.js";

if (process.env.MINDI_LIVE_ACCEPTANCE !== "1")
  throw new Error(
    "Set MINDI_LIVE_ACCEPTANCE=1 for native automatic triage acceptance",
  );
const root = await mkdtemp(join(tmpdir(), "mindi-triage-acceptance-"));
const token = randomUUID() + randomUUID();
const model = process.env.MINDI_ACCEPTANCE_MODEL ?? "openai-codex/gpt-6-astra";
const config = {
  stateRoot: root,
  workspace: root,
  port: 0,
  profiles: [
    {
      id: "planner",
      instructions:
        "Use the granted kanban tools to carry out the exact requested plan. Read returned IDs and revisions before updating. Do not create extra cards.",
      modelIds: [model],
      defaultModelId: model,
      tools: [...AGENT_TASK_TOOLS],
      approvalMode: "write" as const,
    },
  ],
};
let app = await startApplication({ config, token });
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
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, `HTTP ${response.status} ${path}`);
  return (await response.json()) as T;
}
try {
  const board = await call<Board>("/boards", "POST", {
    name: "Native automatic triage",
    idempotencyKey: "native",
  });
  const parent = await call<Task>(`/boards/${board.id}/tasks`, "POST", {
    title: "Plan acceptance project",
    assignee: "planner",
    status: "triage",
    body: "Create exactly two children titled Design and Build, both with this task as parent. Leave both unassigned. Leave Design in todo and prepare Build as ready. Set Build dependencies to exactly [Design ID]. Do not create other cards. Finish with task_result outcome review and summary exactly TRIAGE_PLAN_829.",
    completionContract:
      "Implementation is not completed by this planning attempt.",
    idempotencyKey: "parent",
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.deepEqual(
    (await call<Page<Attempt>>(`/tasks/${parent.id}/attempts`)).items,
    [],
  );
  assert.equal((await call<Task>(`/tasks/${parent.id}`)).status, "triage");
  await call(`/boards/${board.id}`, "PATCH", {
    expectedRevision: board.revision,
    dispatchMode: "auto",
  });
  let attempt: Attempt | undefined;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    attempt = (await call<Page<Attempt>>(`/tasks/${parent.id}/attempts`))
      .items[0];
    if (attempt && attempt.state !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  evidence.attempt = attempt;
  assert.equal(attempt?.state, "review", JSON.stringify(attempt));
  assert.equal(attempt?.summary, "TRIAGE_PLAN_829");
  assert.equal((await call<Task>(`/tasks/${parent.id}`)).status, "todo");
  assert.ok(attempt?.runId);
  const run = await call<Run>(`/runs/${attempt.runId}`);
  assert.equal(run.state, "completed");
  assert.equal(run.task?.attemptId, attempt.id);
  const cards = await call<Page<Task>>(`/boards/${board.id}/tasks`);
  assert.equal(cards.items.length, 3);
  const design = cards.items.find((card) => card.title === "Design");
  const build = cards.items.find((card) => card.title === "Build");
  assert.ok(design && build);
  assert.equal(design.status, "todo");
  assert.equal(build.status, "ready");
  assert.equal(design.parentId, parent.id);
  assert.equal(build.parentId, parent.id);
  assert.deepEqual(design.dependencies, []);
  assert.deepEqual(build.dependencies, [design.id]);
  for (const card of [design, build]) {
    assert.equal(card.assignee, null);
    assert.deepEqual(
      (await call<Page<Attempt>>(`/tasks/${card.id}/attempts`)).items,
      [],
    );
  }
  const attempts = await call<Page<Attempt>>(`/tasks/${parent.id}/attempts`);
  assert.equal(attempts.items.length, 1);
  await app.close();
  app = await startApplication({ config, token });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.deepEqual(await call(`/boards/${board.id}/tasks`), cards);
  assert.deepEqual(await call(`/tasks/${parent.id}/attempts`), attempts);
  evidence.cards = cards;
  evidence.run = run;
  evidence.passed = true;
  console.log(
    "Native automatic triage, exact children, independent dependency, parent todo and restart passed",
  );
} finally {
  await app.close();
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
}
