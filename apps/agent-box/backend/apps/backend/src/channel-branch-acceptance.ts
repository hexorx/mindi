import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery, Message } from "@mindi/messaging";
import { startApplication } from "./application.js";

if (process.env.MINDI_LIVE_ACCEPTANCE !== "1")
  throw new Error(
    "Set MINDI_LIVE_ACCEPTANCE=1 for native channel branch acceptance",
  );
const root = await mkdtemp(join(tmpdir(), "mindi-channel-branch-acceptance-"));
const token = randomUUID() + randomUUID();
const model = process.env.MINDI_ACCEPTANCE_MODEL ?? "openai-codex/gpt-6-astra";
const config = {
  stateRoot: root,
  workspace: root,
  port: 0,
  profiles: [
    {
      id: "alice",
      instructions:
        "Answer the operator's message precisely. Use the existing conversation when answering follow-up questions. Do not use tools unless needed.",
      modelIds: [model],
      defaultModelId: model,
      tools: ["read", "dm_send"],
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
async function finished(id: string): Promise<Delivery> {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const delivery = await call<Delivery>(`/deliveries/${id}`);
    if (!["queued", "running"].includes(delivery.state)) return delivery;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Native delivery timed out");
}
try {
  const dm = await call<{ id: string }>("/dms", "POST", {
    recipientId: "agent:alice",
  });
  const send = async (text: string, key: string, branchId?: string) => {
    const message = await call<Message>(`/channels/${dm.id}/messages`, "POST", {
      text,
      idempotencyKey: key,
      ...(branchId ? { branchId } : {}),
    });
    const delivery = await finished(message.id);
    assert.equal(delivery.state, "completed", JSON.stringify(delivery));
    return delivery;
  };
  const first = await send(
    "Remember private marker MAIN_943. Reply only MAIN_READY.",
    "main",
  );
  assert.equal(first.output?.trim(), "MAIN_READY");
  const points = await call<Array<{ entryId: string }>>(
    `/channels/${dm.id}/conversations/alice/branches`,
  );
  assert.ok(points[0]);
  const branch = await call<{ id: string }>(
    `/channels/${dm.id}/branches`,
    "POST",
    { name: "Native alternative", idempotencyKey: "branch" },
  );
  const request = {
    profileId: "alice",
    entryId: points[0].entryId,
    idempotencyKey: "fork",
  };
  const fork = await call<{ threadId: string; state: string }>(
    `/channel-branches/${branch.id}/forks`,
    "POST",
    request,
  );
  assert.equal(fork.state, "completed");
  const child = await send(
    `Remember private marker CHILD_527. Use dm_send once with channelId ${dm.id} to send the exact text TOOL_CHILD. Do not supply branchId or replyTo. Then reply only CHILD_READY.`,
    "child",
    branch.id,
  );
  assert.equal(child.output?.trim(), "CHILD_READY");
  assert.equal(child.threadId, fork.threadId);
  assert.notEqual(child.threadId, first.threadId);
  const initial = await call<{ items: Message[] }>(
    `/channels/${dm.id}/messages?branchId=${branch.id}`,
  );
  const tool = initial.items.filter((m) => m.text === "TOOL_CHILD");
  assert.equal(tool.length, 1);
  assert.equal(tool[0]!.senderId, "agent:alice");
  assert.equal(tool[0]!.rootId, child.messageId);
  await app.close();
  app = await startApplication({ config, token });
  assert.deepEqual(
    await call(`/channel-branches/${branch.id}/forks`, "POST", request),
    fork,
  );
  const mainRecall = await send(
    "What is this conversation's private marker? Reply only the marker.",
    "main-recall",
  );
  assert.equal(mainRecall.output?.trim(), "MAIN_943");
  const childRecall = await send(
    "What is this branch's private marker? Reply only the marker. Do not call tools.",
    "child-recall",
    branch.id,
  );
  assert.equal(childRecall.output?.trim(), "CHILD_527");
  assert.equal(mainRecall.threadId, first.threadId);
  assert.equal(childRecall.threadId, child.threadId);
  const mainHistory = await call<{ items: Message[] }>(
    `/channels/${dm.id}/messages`,
  );
  assert.equal(mainHistory.items.length, 4);
  assert.ok(mainHistory.items.every((m) => !("branchId" in m)));
  const childHistory = await call<{ items: Message[] }>(
    `/channels/${dm.id}/messages?branchId=${branch.id}`,
  );
  assert.equal(childHistory.items.length, 5);
  assert.ok(childHistory.items.every((m) => m.branchId === branch.id));
  Object.assign(evidence, {
    passed: true,
    first,
    child,
    mainRecall,
    childRecall,
    fork,
    branch,
    mainHistory,
    childHistory,
  });
  console.log(
    "Native channel branch, inherited DM tool routing, independent recall and restart passed",
  );
} finally {
  await app.close();
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
}
