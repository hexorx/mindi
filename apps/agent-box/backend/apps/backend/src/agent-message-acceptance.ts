import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_MESSAGE_TOOLS } from "@mindi/agent-tools";
import type { Run } from "@mindi/agent-runtime";
import type { Page, Message, Delivery } from "@mindi/messaging";
import { startApplication } from "./application.js";

if (process.env.MINDI_LIVE_ACCEPTANCE !== "1")
  throw new Error(
    "Set MINDI_LIVE_ACCEPTANCE=1 for native agent message acceptance",
  );
const root = await mkdtemp(join(tmpdir(), "mindi-agent-message-acceptance-"));
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
        "For operator requests, use the requested DM tools exactly once each. For messages from other agents, reply with only ACK and do not call any tools.",
      modelIds: [model],
      defaultModelId: model,
      tools: [...AGENT_MESSAGE_TOOLS],
      approvalMode: "write" as const,
    },
    {
      id: "bob",
      instructions: "Reply with only ACK. Do not call tools.",
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
try {
  const thread = await call<{ id: string }>("/threads", "POST", {
    profileId: "planner",
  });
  const run = await call<Run>(`/threads/${thread.id}/runs`, "POST", {
    idempotencyKey: "native-dm",
    text: "Use dm_open to open a DM with agent:bob. Then use dm_send exactly once to send the exact text NATIVE_AGENT_DM_829 into that DM. Use dm_list to verify the DM exists. Do not send any other messages; finish with SENT.",
  });
  const deadline = Date.now() + 240000;
  let result = run;
  let deliveries: Page<Delivery> = { items: [], nextCursor: null };
  while (Date.now() < deadline) {
    result = await call<Run>(`/runs/${run.id}`);
    deliveries = await call<Page<Delivery>>("/deliveries");
    if (result.state === "completed" && deliveries.items.length === 0) break;
    if (
      deliveries.items.some((d) =>
        ["failed", "cancelled", "attention_required"].includes(d.state),
      )
    )
      break;
    if (
      result.state === "completed" &&
      deliveries.items.length === 9 &&
      deliveries.items.every((d) => ["completed", "blocked"].includes(d.state))
    )
      break;
    if (!["queued", "running", "completed"].includes(result.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  evidence.run = result;
  evidence.deliveries = deliveries;
  assert.equal(result.state, "completed");
  assert.equal(deliveries.items.length, 9);
  assert.equal(
    deliveries.items.filter((d) => d.state === "completed").length,
    8,
  );
  assert.equal(deliveries.items.filter((d) => d.state === "blocked").length, 1);
  const messages = await call<Page<Message>>(
    `/channels/${deliveries.items[0]!.channelId}/messages`,
  );
  assert.equal(messages.items.length, 9);
  const first = messages.items.find((m) => m.hop === 0)!;
  assert.equal(first.text, "NATIVE_AGENT_DM_829");
  assert.equal(first.senderId, "agent:planner");
  assert.equal(first.recipientId, "agent:bob");
  assert.deepEqual(
    messages.items.map((m) => m.hop).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.ok(messages.items.every((m) => m.rootId === first.id));
  await app.close();
  app = await startApplication({ config, token });
  assert.deepEqual(await call("/deliveries"), deliveries);
  assert.deepEqual(
    await call(`/channels/${first.channelId}/messages`),
    messages,
  );
  evidence.messages = messages;
  evidence.passed = true;
  console.log(
    "Native OMP DM tools, attributed delivery, bounded agent replies and restart passed",
  );
} finally {
  await app.close();
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
}
