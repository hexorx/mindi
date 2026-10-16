import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TASK_TOOLS } from "@mindi/agent-tools";
import type { Run } from "@mindi/agent-runtime";
import type { Page, Task, TaskComment } from "@mindi/tasks";
import { startApplication } from "./application.js";

if (process.env.MINDI_LIVE_ACCEPTANCE !== "1")
  throw new Error(
    "Set MINDI_LIVE_ACCEPTANCE=1 for native agent tools acceptance",
  );
const root = await mkdtemp(join(tmpdir(), "mindi-agent-tools-acceptance-"));
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
  const board = await call<{ id: string }>("/boards", "POST", {
    name: "Native agent planning",
    idempotencyKey: "native",
  });
  const thread = await call<{ id: string }>("/threads", "POST", {
    profileId: "planner",
  });
  const run = await call<Run>(`/threads/${thread.id}/runs`, "POST", {
    idempotencyKey: "plan",
    text: `On board ${board.id}, create exactly two cards titled Design and Build, both assigned to planner. Leave Design in todo. Set Build's parentId to Design's ID, and separately set Build's dependencies to [Design's ID] using kanban_update. Add a comment to Build containing exactly NATIVE_PLAN_619. Prepare Build as ready using kanban_prepare with reason exactly NATIVE_READY_619. Use returned revisions for mutations. Inspect the final cards, then reply briefly. Do not execute tasks or create any other cards.`,
  });
  let result = run;
  const deadline = Date.now() + 180000;
  while (
    Date.now() < deadline &&
    ["queued", "running"].includes(result.state)
  ) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    result = await call<Run>(`/runs/${run.id}`);
  }
  evidence.run = result;
  assert.equal(result.state, "completed", JSON.stringify(result));
  const cards = await call<Page<Task>>(`/boards/${board.id}/tasks`);
  assert.equal(cards.items.length, 2);
  const design = cards.items.find((card) => card.title === "Design");
  const build = cards.items.find((card) => card.title === "Build");
  assert.ok(design && build);
  assert.equal(design.status, "todo");
  assert.equal(build.status, "ready");
  assert.equal(build.parentId, design.id);
  assert.deepEqual(build.dependencies, [design.id]);
  for (const card of cards.items) {
    assert.equal(card.assignee, "planner");
    assert.deepEqual(
      (await call<Page<unknown>>(`/tasks/${card.id}/attempts`)).items,
      [],
    );
  }
  const comments = await call<Page<TaskComment>>(`/tasks/${build.id}/comments`);
  for (const body of ["NATIVE_PLAN_619", "NATIVE_READY_619"]) {
    const matches = comments.items.filter((comment) => comment.body === body);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.author, "planner");
  }
  await app.close();
  app = await startApplication({ config, token });
  assert.deepEqual(await call(`/boards/${board.id}/tasks`), cards);
  assert.deepEqual(await call(`/tasks/${build.id}/comments`), comments);
  evidence.cards = cards;
  evidence.comments = comments;
  evidence.passed = true;
  console.log(
    "Native agent creation, parent/dependency links, attributed comments, preparation and restart passed",
  );
} finally {
  await app.close();
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
}
