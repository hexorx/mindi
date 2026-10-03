import { createHash } from "node:crypto";
import type { AgentRuntime, ThreadOwner } from "@mindi/agent-runtime";
import type { MessagingStore } from "@mindi/messaging";
import type { TaskStore } from "@mindi/tasks";
function all<T>(
  read: (input: { after?: string; limit: number }) => {
    items: T[];
    nextCursor?: string | null;
  },
): T[] {
  const result: T[] = [];
  let after: string | undefined;
  do {
    const page = read({ limit: 100, ...(after ? { after } : {}) });
    result.push(...page.items);
    after = page.nextCursor ?? undefined;
  } while (after);
  return result;
}
/** Called before listening, and again before an explicit unresolved-owner claim. */
export function reconcileThreadOwnership({
  runtime,
  messaging,
  tasks,
}: {
  runtime: AgentRuntime;
  messaging?: MessagingStore;
  tasks?: TaskStore;
}): void {
  const bindings: Array<{
    threadId?: string;
    idempotencyKey?: string;
    owner: ThreadOwner;
  }> = [];
  if (tasks)
    for (const board of all((page) =>
      tasks.listBoards({ ...page, includeArchived: true }),
    ))
      for (const task of all((page) =>
        tasks.listTasks(board.id, { ...page, includeArchived: true }),
      ))
        for (const attempt of all((page) => tasks.listAttempts(task.id, page)))
          if (attempt.threadId)
            bindings.push({
              threadId: attempt.threadId,
              owner: { kind: "task", id: task.id },
            });
  if (messaging) {
    const profiles = new Map<string, Set<string>>();
    const remember = (
      channelId: string,
      profileId: string,
      threadId?: string,
    ) => {
      const set = profiles.get(channelId) ?? new Set<string>();
      set.add(profileId);
      profiles.set(channelId, set);
      if (threadId)
        bindings.push({ threadId, owner: { kind: "channel", id: channelId } });
    };
    for (const channel of all((page) => messaging.listChannels(page))) {
      for (const profile of runtime.listProfiles())
        remember(channel.id, profile.id);
      for (const member of channel.members)
        if (member.startsWith("agent:")) remember(channel.id, member.slice(6));
      for (const conversation of all((page) =>
        messaging.listConversations(channel.id, page),
      ))
        remember(channel.id, conversation.profileId, conversation.threadId);
      for (const branch of all((page) =>
        messaging.listBranches(channel.id, page),
      ))
        for (const conversation of all((page) =>
          messaging.listConversations(channel.id, {
            ...page,
            branchId: branch.id,
          }),
        ))
          remember(channel.id, conversation.profileId, conversation.threadId);
    }
    for (const delivery of all((page) => messaging.listDeliveries(page)))
      remember(delivery.channelId, delivery.profileId, delivery.threadId);
    for (const fork of all((page) =>
      messaging.listBranchForks(undefined, page),
    ))
      remember(fork.channelId, fork.profileId, fork.parentThreadId);
    for (const [channelId, ids] of profiles)
      for (const profileId of ids)
        bindings.push({
          idempotencyKey:
            "messaging:" +
            createHash("sha256")
              .update(JSON.stringify([channelId, profileId]))
              .digest("hex"),
          owner: { kind: "channel", id: channelId },
        });
  }
  runtime.reconcileThreadOwners(bindings);
}
