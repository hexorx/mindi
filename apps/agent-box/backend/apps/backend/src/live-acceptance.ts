/** Opt-in provider acceptance; never imported by deterministic tests. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Run,
  RunEvent,
  Thread,
  BranchPoint,
  ForkOperation,
} from "@mindi/agent-runtime";
import { startApplication } from "./application.js";
import type { BackendConfig } from "./config.js";
async function main() {
  if (process.env.MINDI_LIVE_ACCEPTANCE !== "1")
    throw new Error(
      "Set MINDI_LIVE_ACCEPTANCE=1 to run real provider acceptance",
    );
  const root = await mkdtemp(join(tmpdir(), "mindi-backend-acceptance-"));
  const token = randomBytes(32).toString("hex");
  const model = process.env.MINDI_LIVE_MODEL ?? "openai-codex/gpt-6-astra";
  const config: BackendConfig = {
    stateRoot: root,
    workspace: root,
    port: 0,
    profiles: ["mira", "rowan"].map((id) => ({
      id,
      instructions: `You are ${id}. Be concise and follow exact response instructions.`,
      modelIds: [model],
      defaultModelId: model,
      tools: [],
    })),
  };
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  let app = await startApplication({ config, token });
  const evidence: Record<string, unknown> = {
    root,
    model,
    node: process.version,
  };
  async function call<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(app.url + path, {
      headers,
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(180_000),
    });
    assert.ok(response.ok, `HTTP ${response.status} for ${path}`);
    return (await response.json()) as T;
  }
  async function turn(id: string, text: string, key: string): Promise<string> {
    const run = await call<Run>(`/threads/${id}/runs`, {
      text,
      idempotencyKey: key,
    });
    const response = await fetch(app.url + `/runs/${run.id}/events`, {
      headers,
      signal: AbortSignal.timeout(180_000),
    });
    assert.ok(response.ok);
    const stream = await response.text();
    const events = stream
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as RunEvent);
    assert.equal((await call<Run>(`/runs/${run.id}`)).state, "completed");
    assert.ok(events.every((event) => event.version === 1));
    return events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join("");
  }
  try {
    const a = await call<Thread>("/threads", { profileId: "mira" });
    const b = await call<Thread>("/threads", { profileId: "rowan" });
    evidence.concurrent = await Promise.all([
      turn(
        a.id,
        "Remember marker ORCHID_782 for this conversation. Reply exactly MIRA_READY.",
        "mira-first",
      ),
      turn(b.id, "Reply exactly ROWAN_READY.", "rowan-first"),
    ]);
    assert.deepEqual(evidence.concurrent, ["MIRA_READY", "ROWAN_READY"]);
    const points = await call<BranchPoint[]>(`/threads/${a.id}/branches`);
    assert.ok(points[0]);
    const fork = await call<Thread>(`/threads/${a.id}/branches`, {
      entryId: points[0].entryId,
      idempotencyKey: "native-fork",
    });
    const forkPage = await call<{
      items: ForkOperation[];
      nextCursor: string | null;
    }>(`/threads/${a.id}/forks`);
    assert.equal(forkPage.items.length, 1);
    const operation = forkPage.items[0]!;
    assert.equal(operation.state, "completed");
    assert.equal(operation.childThreadId, fork.id);
    assert.deepEqual(
      await call(`/threads/${a.id}/branches`, {
        entryId: points[0].entryId,
        idempotencyKey: "native-fork",
      }),
      fork,
    );
    assert.equal(
      (await call<{ state: string }>(`/forks/${operation.id}/ownership`)).state,
      "stopped",
    );
    evidence.forkOperation = operation;
    evidence.branch = await turn(
      fork.id,
      "This branch marker is AMBER_263. Reply exactly BRANCH_READY.",
      "fork-first",
    );
    assert.equal(evidence.branch, "BRANCH_READY");
    await app.close();
    app = await startApplication({ config, token });
    assert.deepEqual(
      await call(`/threads/${a.id}/branches`, {
        entryId: points[0].entryId,
        idempotencyKey: "native-fork",
      }),
      fork,
    );
    assert.deepEqual(await call(`/threads/${a.id}/forks`), forkPage);
    evidence.original = await turn(
      a.id,
      "What exact marker did I ask you to remember? Reply only the marker.",
      "mira-after-restart",
    );
    evidence.child = await turn(
      fork.id,
      "What is this branch marker? Reply only the marker.",
      "fork-after-restart",
    );
    assert.equal(evidence.original, "ORCHID_782");
    assert.equal(evidence.child, "AMBER_263");
    if (process.env.MINDI_LIVE_CLAUDE === "1") {
      await app.close();
      config.claude = { permissionKinds: [] };
      config.profiles.push({
        id: "coder",
        instructions:
          "Use delegate_claude when requested, then report the actual tool result exactly.",
        modelIds: [model],
        defaultModelId: model,
        // Preauthorize only the parent delegation; child tool policy stays empty.
        approvalMode: "yolo",
        tools: ["delegate_claude"],
      });
      app = await startApplication({ config, token });
      const coder = await call<Thread>("/threads", { profileId: "coder" });
      evidence.claude = await turn(
        coder.id,
        "Use delegate_claude to ask native Claude to reply exactly NATIVE_CLAUDE_OK. Return only the exact answer after the tool succeeds.",
        "claude",
      );
      assert.equal(evidence.claude, "NATIVE_CLAUDE_OK");
      const transcripts = await readdir(join(root, "transcripts"));
      assert.ok(transcripts.length > 0);
      const rows = (
        await readFile(join(root, "transcripts", transcripts[0]!), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event?: { type?: string } });
      assert.equal(rows.at(-1)?.event?.type, "completed");
      evidence.claudeTranscriptCompleted = true;
    }
    const hindsight = process.env.MINDI_LIVE_HINDSIGHT_URL;
    if (hindsight) {
      const url = new URL(hindsight);
      assert.equal(url.hostname, "127.0.0.1");
      assert.equal(url.protocol, "http:");
      assert.ok(!url.username && !url.password && !url.search && !url.hash);
      const banks = ["writer", "isolated"].map(
        (id) => `mindi-acceptance-${id}-${randomBytes(12).toString("hex")}`,
      );
      async function memory(
        bank: string,
        path: string,
        method: string,
        body?: unknown,
      ): Promise<unknown> {
        assert.ok(banks.includes(bank));
        const response = await fetch(
          `${url.origin}/v1/default/banks/${bank}${path}`,
          {
            method,
            headers: { "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: AbortSignal.timeout(60_000),
          },
        );
        assert.ok(response.ok, `Hindsight ${method} ${response.status}`);
        return response.json();
      }
      try {
        for (const bank of banks)
          await memory(bank, "", "PUT", { enable_observations: false });
        await app.close();
        config.profiles.push(
          ...banks.map((bank, index) => ({
            id: `memory_${index}`,
            instructions:
              "Use relevant injected project memories. Follow exact response instructions.",
            modelIds: [model],
            defaultModelId: model,
            tools: [],
            memory: { url: url.origin, bankId: bank },
          })),
        );
        app = await startApplication({ config, token });
        const writer = await call<Thread>("/threads", {
          profileId: "memory_0",
        });
        evidence.memoryWriter = await turn(
          writer.id,
          "Synthetic project Marigold has release label TEAL_491. Remember this stable project fact for future conversations. Acknowledge briefly without tools.",
          "memory-write",
        );
        const deadline = Date.now() + 120_000;
        let retained = false;
        while (Date.now() < deadline) {
          const facts = await memory(banks[0]!, "/memories/recall", "POST", {
            query: "Marigold release label",
            budget: "low",
            max_tokens: 1000,
          });
          if (JSON.stringify(facts).includes("TEAL_491")) {
            retained = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
        assert.ok(retained, "Native retention never became retrievable");
        const reader = await call<Thread>("/threads", {
          profileId: "memory_0",
        });
        const isolated = await call<Thread>("/threads", {
          profileId: "memory_1",
        });
        const query =
          "What is project Marigold release label from previous conversations? Use injected memory without tools. Reply exactly the label or UNKNOWN if absent.";
        evidence.memoryReader = await turn(reader.id, query, "memory-read");
        evidence.memoryIsolated = await turn(
          isolated.id,
          query,
          "memory-isolated",
        );
        assert.equal(evidence.memoryReader, "TEAL_491");
        assert.equal(evidence.memoryIsolated, "UNKNOWN");
      } finally {
        await app.close();
        for (const bank of banks) await memory(bank, "", "DELETE");
        evidence.memoryBanksDeleted = true;
      }
    }
    evidence.result = "PASS";
  } catch (error) {
    evidence.result = "FAIL";
    evidence.error =
      error instanceof Error ? error.message : "Acceptance failed";
    process.exitCode = 1;
  } finally {
    await app.close();
    await writeFile(
      join(root, "evidence.json"),
      JSON.stringify(evidence, null, 2),
    );
    process.stdout.write(JSON.stringify(evidence) + "\n");
  }
}
void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Acceptance failed"}\n`,
  );
  process.exitCode = 1;
});
