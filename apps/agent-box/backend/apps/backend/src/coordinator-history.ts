import { RuntimeError, type AgentRuntime } from "@mindi/agent-runtime";

/** Import public product history; keep the original native journal untouched. */
export function coordinatorHistory(
  runtime: AgentRuntime,
  input: { threadId: string; sessionPath: string; signal: AbortSignal },
) {
  input.signal.throwIfAborted();
  const thread = runtime.getThread(input.threadId);
  if (thread.sessionPath !== input.sessionPath || thread.parentId)
    throw new RuntimeError(
      "conflict",
      "Legacy fork history requires explicit migration; original history is unchanged",
    );
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const run of runtime.listRuns(thread.id)) {
    input.signal.throwIfAborted();
    if (run.state === "running") continue;
    messages.push({ role: "user", content: run.text });
    let after = 0;
    let answer = "";
    const tools: Array<{ name: string; state: string }> = [];
    while (true) {
      const events = runtime.events(run.id, after);
      if (!events.length) break;
      for (const event of events) {
        if (event.type === "text") answer += event.text;
        if (event.type === "tool")
          tools.push({ name: event.name, state: event.state });
      }
      after = events[events.length - 1]!.sequence;
    }
    messages.push({
      role: "assistant",
      content: JSON.stringify({
        runId: run.id,
        state: run.state,
        answer,
        tools,
        interactions: runtime.listInteractions(run.id),
      }),
    });
  }
  return Promise.resolve(messages);
}
