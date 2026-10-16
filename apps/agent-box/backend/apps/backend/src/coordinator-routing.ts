import type { AgentWorker } from "@mindi/agent-runtime";

/** Selection is operator configuration; callers cannot choose an execution engine. */
export function routeCoordinator(
  profileId: string,
  coordinator: AgentWorker,
  specialist: AgentWorker,
): AgentWorker {
  const worker = (id: string) => (id === profileId ? coordinator : specialist);
  return {
    run: (input, emit) => worker(input.profile.id).run(input, emit),
    fork: (input) => worker(input.profile.id).fork(input),
    branchPoints: (input) =>
      worker(input.profile.id).branchPoints?.(input) ?? Promise.resolve([]),
  };
}
