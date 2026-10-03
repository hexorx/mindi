import { DESKTOP_AGENT_TOOLS } from "@mindi/desktop/agent-contract";
interface Schema {
  optional(): Schema;
  nullable(): Schema;
}
interface Block {
  type: string;
  [key: string]: unknown;
}
interface Host {
  zod: {
    string(): Schema;
    number(): Schema;
    boolean(): Schema;
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
    ): Promise<{ content: Block[] }>;
  }): void;
}
/** Native image parts stay images; the model receives only a run-scoped capability. */
export default function desktopExtension(host: Host): void {
  const url = new URL(process.env.MINDI_DESKTOP_TOOLS_URL ?? "");
  const token = process.env.MINDI_DESKTOP_TOOLS_TOKEN ?? "";
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/invoke" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(token)
  )
    throw new Error("Invalid desktop capability");
  const grants: unknown = JSON.parse(
    process.env.MINDI_DESKTOP_TOOLS_GRANTS ?? "[]",
  );
  if (
    !Array.isArray(grants) ||
    grants.length > DESKTOP_AGENT_TOOLS.length ||
    new Set(grants).size !== grants.length ||
    grants.some(
      (name) => !(DESKTOP_AGENT_TOOLS as readonly unknown[]).includes(name),
    )
  )
    throw new Error("Invalid desktop grants");
  const z = host.zod;
  const optional = (schema: Schema) => schema.nullable().optional();
  const numeric = [
    "pid",
    "window_id",
    "x",
    "y",
    "from_x",
    "from_y",
    "to_x",
    "to_y",
    "duration_ms",
    "steps",
    "count",
    "amount",
    "element_index",
    "width",
    "height",
  ];
  const strings = [
    "text",
    "key",
    "button",
    "direction",
    "by",
    "element_token",
    "snapshot_id",
    "value",
  ];
  const arrays = ["keys", "modifier", "modifiers", "path"];
  const input = Object.fromEntries([
    ...numeric.map((name) => [name, optional(z.number())]),
    ...strings.map((name) => [name, optional(z.string())]),
    ...arrays.map((name) => [name, optional(z.array(z.string()))]),
  ]);
  for (const name of grants as string[]) {
    const capture = name.endsWith("_capture");
    host.registerTool({
      name,
      label: name,
      approval: capture ? "read" : "write",
      loadMode: "essential",
      description: capture
        ? "Capture this persona's desktop or explicit window. Returns an image and observation identifier required for input."
        : "Act on the last captured desktop or window using its observation. Actions: click, drag, type_text, press_key, hotkey, scroll; window actions also support double_click, right_click, set_value, invoke_menu, set_window_frame. Desktop supports move_cursor. Do not retry uncertain input; capture again after a successful mutation.",
      parameters: z.object(
        capture
          ? name === "desktop_capture"
            ? {}
            : {
                pid: z.number(),
                window_id: z.number(),
                max_depth: optional(z.number()),
                max_elements: optional(z.number()),
                query: optional(z.string()),
              }
          : {
              observation: z.string(),
              action: z.string(),
              input: z.object(input),
            },
      ),
      async execute(callId, args, signal) {
        if (signal?.aborted) throw new Error("Desktop tool cancelled");
        const omitNulls = (value: unknown): unknown => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            return value;
          return Object.fromEntries(
            Object.entries(value)
              .filter(([, value]) => value !== null && value !== undefined)
              .map(([key, value]) => [key, omitNulls(value)]),
          );
        };
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ tool: name, callId, args: omitNulls(args) }),
          signal,
        });
        if (!response.ok)
          throw new Error(`Desktop tool rejected (${response.status})`);
        const result = (await response.json()) as { content?: unknown };
        if (
          !Array.isArray(result.content) ||
          result.content.some((block: unknown) => {
            if (!block || typeof block !== "object") return true;
            const b = block as Block;
            return !(
              (b.type === "text" && typeof b.text === "string") ||
              (b.type === "image" &&
                typeof b.data === "string" &&
                typeof b.mimeType === "string")
            );
          })
        )
          throw new Error("Invalid desktop tool result");
        return { content: result.content as Block[] };
      },
    });
  }
}
