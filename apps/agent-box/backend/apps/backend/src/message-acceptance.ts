import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Delivery, Message } from "@mindi/messaging";
import { startApplication } from "./application.js";

if (process.env.MINDI_LIVE_ACCEPTANCE !== "1")
  throw new Error("Set MINDI_LIVE_ACCEPTANCE=1 for native message acceptance");
const root = await mkdtemp(join(tmpdir(), "mindi-message-acceptance-"));
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
      tools: ["read"],
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
  const request = {
    text: "Remember the private test fact APPLE_731. Reply with exactly ACK_731.",
    idempotencyKey: "remember",
  };
  const message = await call<Message>(
    `/channels/${dm.id}/messages`,
    "POST",
    request,
  );
  const first = await finished(message.id);
  evidence.first = first;
  assert.equal(first.state, "completed");
  assert.equal(first.output?.trim(), "ACK_731");
  assert.equal(
    (await call<Message>(`/messages/${first.replyMessageId}`)).senderId,
    "agent:alice",
  );
  await app.close();
  app = await startApplication({ config, token });
  assert.deepEqual(
    await call(`/channels/${dm.id}/messages`, "POST", request),
    message,
  );
  assert.deepEqual(await call(`/deliveries/${message.id}`), first);
  const next = await call<Message>(`/channels/${dm.id}/messages`, "POST", {
    text: "What is the private test fact from our earlier message? Reply with only that fact.",
    idempotencyKey: "recall",
  });
  const second = await finished(next.id);
  evidence.second = second;
  assert.equal(second.state, "completed");
  assert.equal(second.output?.trim(), "APPLE_731");
  assert.equal(second.threadId, first.threadId);
  assert.notEqual(second.runId, first.runId);
  assert.equal(
    (await call<{ items: Message[] }>(`/channels/${dm.id}/messages`)).items
      .length,
    4,
  );
  evidence.passed = true;
  console.log(
    "Native DM delivery, exact output, restart deduplication and resumed session fact passed",
  );
} finally {
  await app.close();
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
}
