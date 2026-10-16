import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Occurrence, Routine, RoutinePublication } from "@mindi/routines";
import { startApplication } from "./application.js";
if (process.env.MINDI_LIVE_ACCEPTANCE !== "1")
  throw new Error("Set MINDI_LIVE_ACCEPTANCE=1 for native routine acceptance");
const root = await mkdtemp(join(tmpdir(), "mindi-routine-acceptance-"));
const token = randomUUID() + randomUUID();
const model = process.env.MINDI_ACCEPTANCE_MODEL ?? "openai-codex/gpt-6-astra";
const config = {
  stateRoot: root,
  workspace: root,
  port: 0,
  profiles: [
    {
      id: "reporter",
      instructions:
        "Execute the routine exactly; report its exact requested output using task_result after writing successfully.",
      modelIds: [model],
      defaultModelId: model,
      tools: ["write"],
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
    name: "Native routines",
    idempotencyKey: "native",
  });
  const channel = await call<{ id: string }>("/channels", "POST", {
    name: "Native routine results",
    members: ["operator", "agent:reporter"],
    idempotencyKey: "results",
  });
  const branch = await call<{ id: string }>(
    `/channels/${channel.id}/branches`,
    "POST",
    { name: "Reports", idempotencyKey: "reports" },
  );
  const routine = await call<Routine>("/routines", "POST", {
    name: "One-time report",
    profileId: "reporter",
    boardId: board.id,
    prompt:
      "Write routine.txt containing exactly ROUTINE_FILE_417. Then use task_result outcome review with summary exactly ROUTINE_REVIEW_417 @literal_unknown.",
    schedule: { kind: "once", at: new Date(Date.now() + 1000).toISOString() },
    idempotencyKey: "once",
    destination: { channelId: channel.id, branchId: branch.id },
  });
  let occurrence: Occurrence | undefined;
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    occurrence = (
      await call<{ items: Occurrence[] }>(`/routines/${routine.id}/runs`)
    ).items[0];
    if (occurrence && !["queued", "running"].includes(occurrence.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(occurrence?.state, "review");
  assert.equal(occurrence?.summary, "ROUTINE_REVIEW_417 @literal_unknown");
  assert.equal(
    await readFile(join(root, "routine.txt"), "utf8"),
    "ROUTINE_FILE_417",
  );
  const history = await call<{ items: Occurrence[] }>(
    `/routines/${routine.id}/runs`,
  );
  assert.equal(history.items.length, 1);
  let publication: RoutinePublication | undefined;
  const publicationDeadline = Date.now() + 10000;
  while (Date.now() < publicationDeadline) {
    publication = (
      await call<{ items: RoutinePublication[] }>(
        `/routines/${routine.id}/publications`,
      )
    ).items[0];
    if (publication?.state === "published") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(publication?.state, "published");
  const message = await call<{
    text: string;
    senderId: string;
    recipientId: null;
    runId: string;
    routineOutput: { state: string; occurrenceId: string };
  }>(`/messages/${publication!.messageId}`);
  assert.equal(message.text, "ROUTINE_REVIEW_417 @literal_unknown");
  assert.equal(message.senderId, "agent:reporter");
  assert.equal(message.recipientId, null);
  assert.equal(message.routineOutput.state, "review");
  assert.equal(message.routineOutput.occurrenceId, occurrence!.id);
  assert.ok(message.runId);
  assert.equal(
    (await call<{ items: unknown[] }>("/deliveries")).items.length,
    0,
  );
  await app.close();
  app = await startApplication({ config, token });
  assert.deepEqual(await call(`/routines/${routine.id}/runs`), history);
  assert.equal(
    (await call<Routine>(`/routines/${routine.id}`)).nextRunAt,
    null,
  );
  assert.deepEqual(
    await call(`/routine-publications/${occurrence!.id}`),
    publication,
  );
  assert.deepEqual(
    (
      await call<{ items: unknown[] }>(
        `/channels/${channel.id}/messages?branchId=${branch.id}`,
      )
    ).items,
    [message],
  );
  evidence.publication = publication;
  evidence.message = message;
  evidence.routineId = routine.id;
  evidence.history = history;
  evidence.passed = true;
  console.log(
    "Native one-time schedule, exact file/output, channel publication and restart passed",
  );
} finally {
  await app.close();
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
}
