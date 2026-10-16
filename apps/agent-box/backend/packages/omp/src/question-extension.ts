import { requestInteractionBridge } from "./bridge-client.js";
interface QuestionContext {
  ui: {
    select(
      question: string,
      choices: string[],
      settings: { signal?: AbortSignal; timeout: number },
    ): Promise<string | undefined>;
    input(
      question: string,
      placeholder: undefined,
      settings: { signal?: AbortSignal; timeout: number },
    ): Promise<string | undefined>;
  };
}
interface QuestionHost {
  zod: {
    string(): unknown;
    boolean(): { optional(): unknown };
    array(item: unknown): { optional(): unknown };
    object(shape: Record<string, unknown>): unknown;
  };
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    hidden: boolean;
    execute: (
      id: string,
      params: unknown,
      signal?: AbortSignal,
      update?: unknown,
      context?: QuestionContext,
    ) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
  }): void;
}
/** RPC-compatible questions; decision storage belongs to the host runtime. */
export default function questionExtension(host: QuestionHost): void {
  host.registerTool({
    name: "ask_user",
    label: "Ask the user",
    description:
      "Ask a question and wait for the user's actual answer. Provide choices for a selection or omit them for free text.",
    hidden: true,
    parameters: host.zod.object({
      question: host.zod.string(),
      choices: host.zod.array(host.zod.string()).optional(),
      multi_select: host.zod.boolean().optional(),
      allow_custom: host.zod.boolean().optional(),
    }),
    async execute(id, params, signal, _update, context) {
      if (
        !params ||
        typeof params !== "object" ||
        !("question" in params) ||
        typeof params.question !== "string" ||
        !params.question.trim() ||
        Buffer.byteLength(params.question) > 16384
      )
        throw new Error("Invalid question");
      const choices = "choices" in params ? params.choices : undefined;
      if (
        choices !== undefined &&
        (!Array.isArray(choices) ||
          !choices.length ||
          choices.length > 32 ||
          Array.from(choices).some(
            (choice) =>
              typeof choice !== "string" ||
              !choice.trim() ||
              choice.length > 256,
          ) ||
          new Set(choices).size !== choices.length)
      )
        throw new Error("Invalid question choices");
      for (const key of ["multi_select", "allow_custom"] as const)
        if (
          key in params &&
          typeof (params as Record<string, unknown>)[key] !== "boolean"
        )
          throw new Error("Invalid question options");
      const multiple = "multi_select" in params && params.multi_select === true;
      const allowCustom =
        !("allow_custom" in params) || params.allow_custom === true;
      if (multiple && !choices) throw new Error("Invalid question choices");
      if (signal?.aborted) throw new Error("Question cancelled");
      const url = process.env.MINDI_QUESTION_URL;
      const token = process.env.MINDI_QUESTION_TOKEN;
      if (url || token) {
        const answer = await bridgeAnswer(
          id,
          params.question,
          choices as string[] | undefined,
          multiple,
          allowCustom,
          url,
          token,
          signal,
        );
        return { content: [{ type: "text", text: answer }] };
      }
      if (choices) {
        // Legacy single-choice clients without explicit custom semantics remain compatible.
        // Multiple answers and explicitly requested custom input never degrade to ui.select.
        if (multiple || ("allow_custom" in params && params.allow_custom))
          throw new Error("Question bridge unavailable");
      }
      if (!context?.ui || signal?.aborted)
        throw new Error("Question cancelled");
      const settings = { signal, timeout: 120000 };
      const answer = choices
        ? await context.ui.select(params.question, choices, settings)
        : await context.ui.input(params.question, undefined, settings);
      if (signal?.aborted || answer === undefined)
        throw new Error("Question cancelled");
      if (
        typeof answer !== "string" ||
        answer.length > 4096 ||
        (choices && !choices.includes(answer))
      )
        throw new Error("Invalid question answer");
      return { content: [{ type: "text", text: answer }] };
    },
  });
}

async function bridgeAnswer(
  callId: string,
  prompt: string,
  choices: string[] | undefined,
  multiple: boolean,
  allowCustom: boolean,
  rawUrl: string | undefined,
  token: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  const answer = await requestInteractionBridge({
    route: "question",
    label: "Question",
    url: rawUrl,
    token,
    callId,
    signal,
    request: choices
      ? {
          kind: "question",
          prompt,
          choices: choices.map((label, index) => ({
            id: `choice-${index}`,
            label,
          })),
          multiple,
          allowCustom,
          timeoutMs: 120000,
        }
      : { kind: "text", prompt, maxLength: 4096, timeoutMs: 120000 },
  });
  if (
    signal?.aborted ||
    (answer &&
      typeof answer === "object" &&
      "cancelled" in answer &&
      answer.cancelled === true)
  )
    throw new Error("Question cancelled");
  if (!choices) {
    if (
      !answer ||
      typeof answer !== "object" ||
      Array.isArray(answer) ||
      Object.keys(answer).length !== 1 ||
      !("text" in answer) ||
      typeof answer.text !== "string" ||
      !answer.text.trim() ||
      Buffer.byteLength(answer.text) > 4096
    )
      throw new Error("Invalid question answer");
    return answer.text;
  }
  if (
    !answer ||
    typeof answer !== "object" ||
    Array.isArray(answer) ||
    Object.keys(answer).some((key) => key !== "choiceIds" && key !== "text") ||
    !("choiceIds" in answer) ||
    !Array.isArray(answer.choiceIds)
  )
    throw new Error("Invalid question answer");
  const ids: unknown[] = answer.choiceIds;
  const custom = "text" in answer ? answer.text : undefined;
  if (
    ids.length > choices.length ||
    new Set(ids).size !== ids.length ||
    ids.some(
      (id) =>
        typeof id !== "string" ||
        !choices.some((_, index) => id === `choice-${index}`),
    ) ||
    (!multiple && ids.length > 1) ||
    (custom !== undefined &&
      (!allowCustom ||
        typeof custom !== "string" ||
        !custom.trim() ||
        Buffer.byteLength(custom) > 4096)) ||
    (!ids.length && custom === undefined) ||
    (!multiple && ids.length && custom !== undefined)
  )
    throw new Error("Invalid question answer");
  const values = ids.map((id) => choices[Number((id as string).slice(7))]);
  if (typeof custom === "string") values.push(custom);
  return multiple ? JSON.stringify(values) : values[0]!;
}
