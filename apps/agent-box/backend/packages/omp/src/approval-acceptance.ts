import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpWorker } from "./index.js";

if (process.env.MINDI_LIVE_ACCEPTANCE !== "1")
  throw new Error("Set MINDI_LIVE_ACCEPTANCE=1 to run native model acceptance");
const model = process.env.MINDI_ACCEPTANCE_MODEL ?? "openai-codex/gpt-6-astra";
const root = await mkdtemp(join(tmpdir(), "mindi-approval-acceptance-"));
const evidence: Record<string, unknown>[] = [];
console.log(`Evidence directory: ${root}`);
try {
  for (const [name, approvalMode, decision] of [
    ["approve", "always-ask", "Approve"],
    ["deny", "always-ask", "Deny"],
    ["write", "write", null],
    ["yolo", "yolo", null],
  ] as const) {
    const cwd = join(root, name);
    await mkdir(join(cwd, ".omp"), { recursive: true });
    // This inherited allow must never bypass the profile's always-ask mode.
    await writeFile(
      join(cwd, ".omp", "config.yml"),
      "tools:\n  approval:\n    write: allow\n",
      { mode: 0o600 },
    );
    const target = join(cwd, "probe.txt");
    const contents = "MINDI_APPROVAL_ACCEPTANCE_782";
    let prompts = 0;
    let decisions = 0;
    let failed = false;
    const worker = new OmpWorker({ cwd, stateRoot: cwd, timeoutMs: 90000 });
    try {
      await worker.run(
        {
          threadId: name,
          runId: name,
          modelId: model,
          profile: {
            id: name,
            instructions:
              "Use write exactly once. If denied, stop and report denial; never retry.",
            tools: ["write"],
            approvalMode,
            modelIds: [model],
            defaultModelId: model,
          },
          text: `Use write to create probe.txt containing exactly ${contents}. Then reply DONE. If denied, reply DENIED.`,
          signal: AbortSignal.timeout(90000),
          requestInteraction: async (request) => {
            prompts++;
            assert.equal(
              await readFile(target, "utf8").catch(() => null),
              null,
              "File must not exist before permission is answered",
            );
            assert.ok(
              decision,
              "Automatic write policy must not request approval",
            );
            assert.equal(request.kind, "choice");
            assert.ok(request.prompt.includes("probe.txt"));
            assert.ok(request.prompt.includes("Allow tool: write"));
            if (request.kind !== "choice") return { cancelled: true };
            const choice = request.choices.find(
              (item) => item.label === decision,
            );
            assert.ok(
              choice,
              "Native permission must offer the exact requested decision",
            );
            decisions++;
            return { choiceId: choice.id };
          },
        },
        () => {},
      );
    } catch (error) {
      failed = true;
      if (name !== "deny") throw error;
    }
    const actual = await readFile(target, "utf8").catch(() => null);
    assert.equal(prompts, decision ? 1 : 0);
    assert.equal(decisions, prompts);
    assert.equal(actual, name === "deny" ? null : contents);
    evidence.push({
      name,
      approvalMode,
      prompts,
      failed,
      file: actual,
      passed: true,
    });
    console.log(`${name}: passed`);
  }
} finally {
  await writeFile(
    join(root, "evidence.json"),
    JSON.stringify(
      {
        model,
        expectedOmpVersion: "18.1.13",
        cases: evidence,
        passed: evidence.length === 4,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
