/** Opt-in native OMP -> Claude ACP -> durable HTTP decision acceptance. */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Interaction, Run, RunEvent, Thread } from "@mindi/agent-runtime";
import { OmpWorker } from "@mindi/omp";
import { startApplication } from "./application.js";

async function main() {
  assert.equal(
    process.env.MINDI_LIVE_ACCEPTANCE,
    "1",
    "Requires explicit MINDI_LIVE_ACCEPTANCE=1",
  );
  const backend = process.env.MINDI_LIVE_INTERACTION_BACKEND ?? "claude";
  assert.ok(["claude", "omp"].includes(backend));
  const root = await mkdtemp(join(tmpdir(), "mindi-interaction-acceptance-"));
  if (backend === "claude") {
    // Native reads normally need no callback. An explicit ask rule makes this
    // disposable fixture exercise Claude's real ACP permission path.
    await mkdir(join(root, ".claude"));
    await writeFile(
      join(root, ".claude", "settings.local.json"),
      JSON.stringify({ permissions: { ask: ["Read"] } }),
      { mode: 0o600 },
    );
  }
  const marker =
    backend === "claude" ? randomBytes(16).toString("hex") : "TEAL";
  await writeFile(join(root, "acceptance-marker.txt"), marker);
  const token = randomBytes(32).toString("hex");
  const model = process.env.MINDI_LIVE_MODEL ?? "openai-codex/gpt-6-astra";
  const diagnostics: string[] = [];
  const app = await startApplication({
    worker: new OmpWorker({
      cwd: root,
      stateRoot: root,
      claude: { permissionKinds: [], interactivePermissions: true },
      onDiagnostic: (text) => diagnostics.push(text),
    }),
    token,
    config: {
      stateRoot: root,
      workspace: root,
      port: 0,
      claude: { permissionKinds: [], interactivePermissions: true },
      profiles: [
        {
          id: "coder",
          instructions:
            backend === "omp"
              ? "Use the ask_user tool when requested. Return the actual selected label exactly without narration."
              : "Delegate the requested task to native Claude using delegate_claude. Report its actual answer exactly; never guess file contents.",
          modelIds: [model],
          defaultModelId: model,
          // This runner tests the tool's own UI/ACP prompt; native tier gates
          // have a separate real-file acceptance runner.
          approvalMode: "yolo",
          tools: backend === "omp" ? ["ask_user"] : ["delegate_claude"],
        },
      ],
    },
  });
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const evidence: Record<string, unknown> = { root, model, backend };
  async function call<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(app.url + path, {
      headers,
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    assert.ok(response.ok, `HTTP ${response.status}: ${path}`);
    return (await response.json()) as T;
  }
  try {
    const thread = await call<Thread>("/threads", { profileId: "coder" });
    const run = await call<Run>(`/threads/${thread.id}/runs`, {
      idempotencyKey: "native-permission",
      text:
        backend === "omp"
          ? "Use the ask_user tool to ask exactly: Which acceptance color? Offer TEAL and AMBER as single-choice options. After I answer, reply only with the selected label."
          : "Use delegate_claude to ask native Claude to read acceptance-marker.txt using its Read tool, then reply with only its exact contents. You cannot know the contents without delegating. Do not run shell commands or edit anything.",
    });
    evidence.runId = run.id;
    const decisions: string[] = [];
    const deadline = Date.now() + 180000;
    let completed = false;
    while (Date.now() < deadline) {
      const interactions = await call<Interaction[]>(
        `/runs/${run.id}/interactions`,
      );
      for (const interaction of interactions.filter(
        (item) => item.state === "pending",
      )) {
        const request = interaction.request;
        assert.equal(request.kind, "choice");
        assert.ok(
          backend === "omp"
            ? request.prompt.includes("Which acceptance color?")
            : request.prompt.includes('"kind":"read"'),
          "Acceptance only approves native reads",
        );
        if (request.kind !== "choice")
          throw new Error("Expected permission choices");
        const choice = request.choices.find((item) =>
          backend === "omp"
            ? item.label === "TEAL"
            : (/allow/i.test(item.label) && !/always/i.test(item.label)) ||
              /^\d+: Yes$/.test(item.label),
        );
        assert.ok(choice, "No one-time read choice offered");
        const result = await call<Interaction>(
          `/runs/${run.id}/interactions/${interaction.id}/respond`,
          { response: { choiceId: choice.id } },
        );
        assert.equal(result.state, "answered");
        decisions.push(result.id);
      }
      const current = await call<Run>(`/runs/${run.id}`);
      if (current.state !== "running") {
        assert.equal(current.state, "completed");
        completed = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(completed, "Native run timed out");
    assert.ok(decisions.length > 0, "Native permission path was not exercised");
    const response = await fetch(app.url + `/runs/${run.id}/events`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const events = (await response.text())
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as RunEvent);
    const answer = events
      .filter((event) => event.type === "text")
      .map((event) => event.text)
      .join("")
      .trim();
    assert.equal(answer, marker);
    evidence.decisions = decisions;
    evidence.exactAnswer = true;
    evidence.result = "PASS";
  } catch (error) {
    evidence.result = "FAIL";
    evidence.diagnostics = diagnostics;
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
