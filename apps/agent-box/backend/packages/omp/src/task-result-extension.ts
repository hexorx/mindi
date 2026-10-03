import { taskOutputPaths } from "@mindi/agent-runtime";
export interface TaskOutcome {
  outputPaths?: string[];
  outcome: "review" | "blocked";
  summary: string;
}
/** Require own data fields, so native/tool inputs cannot run getters. */
function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("Invalid task outcome");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !descriptors[key] || !("value" in descriptors[key]!))
  )
    throw new Error("Invalid task outcome");
  return value as Record<string, unknown>;
}
export function taskOutcome(value: unknown, allowOutputs = false): TaskOutcome {
  const hasOutputs =
    !!value && typeof value === "object" && Object.hasOwn(value, "outputPaths");
  const report = exactObject(
    value,
    hasOutputs && allowOutputs
      ? ["outcome", "summary", "outputPaths"]
      : ["outcome", "summary"],
  );
  if (
    (report.outcome !== "review" && report.outcome !== "blocked") ||
    typeof report.summary !== "string" ||
    (!report.summary.trim() && !(report.summary === "" && hasOutputs)) ||
    report.summary.includes("\0") ||
    report.summary.length > 10000
  )
    throw new Error("Invalid task outcome");
  return {
    outcome: report.outcome,
    summary: report.summary,
    ...(hasOutputs ? { outputPaths: taskOutputPaths(report.outputPaths) } : {}),
  };
}
export function taskOutcomeResult(
  value: unknown,
  allowOutputs = false,
): TaskOutcome {
  const result = exactObject(value, ["content", "details"]);
  const details = exactObject(result.details, ["mindiTaskOutcome"]);
  if (!Array.isArray(result.content) || result.content.length !== 1)
    throw new Error("Invalid task outcome");
  const text = exactObject(result.content[0], ["type", "text"]);
  if (
    text.type !== "text" ||
    text.text !== "Task outcome recorded for operator review."
  )
    throw new Error("Invalid task outcome");
  return taskOutcome(details.mindiTaskOutcome, allowOutputs);
}
interface TaskResultHost {
  zod: {
    string(): unknown;
    array(item: unknown): { optional(): unknown };
    enum(values: [string, ...string[]]): unknown;
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
      content: Array<{ type: "text"; text: string }>;
      details: { mindiTaskOutcome: TaskOutcome };
    }>;
  }): void;
}
/** Reports structured evidence only; the host owns durable task transitions. */
export default function taskResultExtension(host: TaskResultHost): void {
  const outputDirectory = process.env.MINDI_TASK_OUTPUT_DIRECTORY;
  host.registerTool({
    name: "task_result",
    label: "Report task outcome",
    description:
      "Report this task attempt once: review when ready for operator review, or blocked when unable to proceed. Include a concise evidence summary. This does not mark the task done." +
      (outputDirectory
        ? ` Place intended output files under ${JSON.stringify(outputDirectory)} and report their relative paths in outputPaths. Summary may be empty when reporting output files. The backend must acquire them before completion.`
        : ""),
    approval: "read",
    loadMode: "essential",
    parameters: host.zod.object({
      outcome: host.zod.enum(["review", "blocked"]),
      summary: host.zod.string(),
      ...(outputDirectory
        ? { outputPaths: host.zod.array(host.zod.string()).optional() }
        : {}),
    }),
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error("Task report cancelled");
      const outcome = taskOutcome(params, !!outputDirectory);
      return {
        content: [
          { type: "text", text: "Task outcome recorded for operator review." },
        ],
        details: { mindiTaskOutcome: outcome },
      };
    },
  });
}
