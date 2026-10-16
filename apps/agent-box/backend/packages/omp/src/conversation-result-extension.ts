import { conversationOutputPaths } from "@mindi/agent-runtime";
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some(
      (key) =>
        !Object.hasOwn(value, key) ||
        !("value" in Object.getOwnPropertyDescriptor(value, key)!),
    )
  )
    throw Error("Invalid conversation output report");
  return value as Record<string, unknown>;
}
export function conversationOutputReport(value: unknown): {
  outputPaths: string[];
} {
  return {
    outputPaths: conversationOutputPaths(
      object(value, ["outputPaths"]).outputPaths,
    ),
  };
}
export function conversationOutputResult(value: unknown): {
  outputPaths: string[];
} {
  const result = object(value, ["content", "details"]);
  if (!Array.isArray(result.content) || result.content.length !== 1)
    throw Error("Invalid conversation output report");
  const content = object(result.content[0], ["type", "text"]);
  if (
    content.type !== "text" ||
    content.text !== "Conversation output files reported."
  )
    throw Error("Invalid conversation output report");
  return conversationOutputReport(
    object(result.details, ["mindiConversationOutput"]).mindiConversationOutput,
  );
}
interface Host {
  zod: {
    string(): unknown;
    array(item: unknown): unknown;
    object(shape: Record<string, unknown>): unknown;
  };
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    approval: "read";
    loadMode: "essential";
    parameters: unknown;
    execute(
      id: string,
      params: unknown,
      signal?: AbortSignal,
    ): Promise<{
      content: { type: "text"; text: string }[];
      details: { mindiConversationOutput: { outputPaths: string[] } };
    }>;
  }): void;
}
/** Reports intended output paths; native runtime owns capture, verification and publication. */
export default function conversationResultExtension(host: Host): void {
  const directory = process.env.MINDI_CONVERSATION_OUTPUT_DIRECTORY;
  if (!directory) throw Error("Conversation output grant unavailable");
  host.registerTool({
    name: "conversation_result",
    label: "Report conversation files",
    description: `Place files intended for this conversation under ${JSON.stringify(directory)} and report their relative paths once. The backend acquires exact bytes before publishing the completed reply.`,
    approval: "read",
    loadMode: "essential",
    parameters: host.zod.object({
      outputPaths: host.zod.array(host.zod.string()),
    }),
    async execute(_id, params, signal) {
      if (signal?.aborted) throw Error("Conversation output report cancelled");
      return {
        content: [
          { type: "text", text: "Conversation output files reported." },
        ],
        details: { mindiConversationOutput: conversationOutputReport(params) },
      };
    },
  });
}
