import { AGENT_TOOLS } from "@mindi/agent-tools";
interface Schema {
  optional(): Schema;
  nullable(): Schema;
}
interface Host {
  zod: {
    string(): Schema;
    number(): Schema;
    array(schema: Schema): Schema;
    object(shape: Record<string, Schema>): Schema;
  };
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    approval: "read" | "write";
    loadMode: "essential";
    parameters: Schema;
    execute(
      id: string,
      args: unknown,
      signal?: AbortSignal,
    ): Promise<{ content: Array<{ type: "text"; text: string }> }>;
  }): void;
}
export default function agentToolsExtension(host: Host): void {
  const url = process.env.MINDI_AGENT_TOOLS_URL ?? "";
  const token = process.env.MINDI_AGENT_TOOLS_TOKEN ?? "";
  const parsed = new URL(url);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port ||
    parsed.pathname !== "/invoke" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    token.length < 32 ||
    token.length > 256
  )
    throw new Error("Invalid agent tool capability");
  const grants: unknown = JSON.parse(
    process.env.MINDI_AGENT_TOOLS_GRANTS ?? "[]",
  );
  if (
    !Array.isArray(grants) ||
    grants.length > AGENT_TOOLS.length ||
    new Set(grants).size !== grants.length ||
    grants.some((name) => !AGENT_TOOLS.includes(name))
  )
    throw new Error("Invalid agent tool grants");
  const z = host.zod;
  const page = {
    after: z.string().nullable().optional(),
    limit: z.number().optional(),
  };
  const edit = {
    maxRetries: z.number().nullable().optional(),
    title: z.string().optional(),
    body: z.string().optional(),
    assignee: z.string().nullable().optional(),
    priority: z.number().optional(),
    parentId: z.string().nullable().optional(),
    completionContract: z.string().optional(),
  };
  const shapes: Record<string, Record<string, Schema>> = {
    dm_open: { recipientId: z.string() },
    dm_list: page,
    dm_send: {
      branchId: z.string().nullable().optional(),
      attachmentIds: z.array(z.string()).optional(),
      channelId: z.string(),
      text: z.string(),
      replyTo: z.string().nullable().optional(),
    },
    channel_post: {
      branchId: z.string().nullable().optional(),
      attachmentIds: z.array(z.string()).optional(),
      channelId: z.string(),
      text: z.string(),
      recipientId: z.string().nullable().optional(),
      replyTo: z.string().nullable().optional(),
    },
    kanban_boards: page,
    kanban_list: { boardId: z.string(), ...page },
    kanban_get: { taskId: z.string() },
    kanban_create: { boardId: z.string(), ...edit, title: z.string() },
    kanban_update: {
      taskId: z.string(),
      expectedRevision: z.number(),
      ...edit,
      dependencies: z.array(z.string()).optional(),
    },
    kanban_prepare: {
      taskId: z.string(),
      expectedRevision: z.number(),
      reason: z.string(),
    },
    kanban_comment: { taskId: z.string(), body: z.string() },
  };
  const descriptions: Record<string, string> = {
    dm_open:
      "Open a private conversation as this persona with a member such as agent:bob or operator.",
    dm_list: "List this persona’s private conversations.",
    dm_send:
      "Send a durable private message as this persona. Optional attachmentIds forward only files admitted to this run; branchId selects a branch in this DM. Agent delivery is asynchronous; this returns the stored message, not an agent response.",
    channel_post:
      "Post to a channel this persona belongs to. Select a recipient explicitly or use null for a broadcast without agent delivery. Optional attachmentIds require an explicit agent recipient and forward only files admitted to this run; branchId must belong to this channel.",
    kanban_boards: "List board identities and dispatch policy.",
    kanban_list:
      "List card metadata on a board; get a card for its instructions.",
    kanban_get: "Read one task and its dependency and parent links.",
    kanban_create:
      "Create a todo card with assigned persona and acceptance contract. Prepare it separately when ready for execution.",
    kanban_update:
      "Edit a card with its current revision, including separate parent and dependency links. Cannot edit routine-owned cards.",
    kanban_prepare:
      "Mark a card ready with its current revision. An automatic board may start it. Cannot prepare routine-owned cards.",
    kanban_comment: "Post a progress comment as this persona.",
  };
  for (const name of grants as string[]) {
    host.registerTool({
      name,
      label: name,
      description: descriptions[name]!,
      approval: [
        "kanban_boards",
        "kanban_list",
        "kanban_get",
        "dm_list",
      ].includes(name)
        ? "read"
        : "write",
      loadMode: "essential",
      parameters: z.object(shapes[name]!),
      async execute(callId, args, signal) {
        if (signal?.aborted) throw new Error("Agent tool cancelled");
        // Native structured outputs may encode omitted optional IDs as empty/null.
        // Normalize only fields whose absence has an unambiguous meaning.
        const normalized =
          args && typeof args === "object" && !Array.isArray(args)
            ? Object.fromEntries(
                Object.entries(args).filter(
                  ([key, value]) =>
                    !(
                      (key === "after" || key === "replyTo") &&
                      key in shapes[name]! &&
                      (value === "" || value === null)
                    ),
                ),
              )
            : args;
        const response = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ tool: name, callId, args: normalized }),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
            : AbortSignal.timeout(15000),
          redirect: "error",
        });
        if (!response.ok)
          throw new Error(
            `Agent tool rejected (${response.status}); inspect the destination before repeating a mutation`,
          );
        const text = await response.text();
        if (Buffer.byteLength(text) > 512 * 1024)
          throw new Error("Agent tool response exceeds limit");
        JSON.parse(text);
        return { content: [{ type: "text", text }] };
      },
    });
  }
}
