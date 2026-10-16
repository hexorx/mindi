import { Type } from "typebox";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  DESKTOP_AGENT_TOOLS,
  type DesktopToolLease,
} from "@mindi/desktop/agent-contract";
import { RuntimeError } from "@mindi/agent-runtime";
import { boundedJson } from "./http.js";
export const isDesktopTool = (name: string) =>
  (DESKTOP_AGENT_TOOLS as readonly string[]).includes(name);
const optional = (
  schema:
    | ReturnType<typeof Type.String>
    | ReturnType<typeof Type.Number>
    | ReturnType<typeof Type.Array>,
) => Type.Optional(Type.Union([schema, Type.Null()]));
const input = Type.Object(
  Object.fromEntries([
    ...[
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
    ].map((name) => [name, optional(Type.Number())]),
    ...[
      "text",
      "key",
      "button",
      "direction",
      "by",
      "element_token",
      "snapshot_id",
      "value",
    ].map((name) => [name, optional(Type.String())]),
    ...["keys", "modifier", "modifiers", "path"].map((name) => [
      name,
      optional(Type.Array(Type.String())),
    ]),
  ]),
  { additionalProperties: false },
);
export const desktopShapes = {
  desktop_capture: {},
  window_capture: {
    pid: Type.Number(),
    window_id: Type.Number(),
    max_depth: optional(Type.Number()),
    max_elements: optional(Type.Number()),
    query: optional(Type.String()),
  },
  desktop_input: { observation: Type.String(), action: Type.String(), input },
  window_input: { observation: Type.String(), action: Type.String(), input },
};
export function desktopDescription(name: string) {
  return name.endsWith("_capture")
    ? "Capture your persona's desktop or explicit window for research. Returns images and an observation identifier required for input."
    : "Research on your persona's desktop using the last capture's observation. Actions: click, drag, type_text, press_key, hotkey, scroll; window actions also support double_click, right_click, set_value, invoke_menu, set_window_frame. Desktop supports move_cursor. Capture again after a successful mutation; never retry uncertain input. Delegate coding and code review; do not use desktop input to run commands or edit code.";
}
function omitNulls(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => [key, omitNulls(value)]),
  );
}
export async function invokeDesktop(
  lease: DesktopToolLease | undefined,
  name: string,
  callId: string,
  args: unknown,
  signal: AbortSignal,
) {
  if (!lease?.tools.includes(name))
    throw new RuntimeError(
      "unavailable",
      "Desktop tool capability unavailable",
    );
  const url = new URL(lease.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/invoke" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(lease.token)
  )
    throw new RuntimeError("invalid", "Invalid desktop capability");
  const result = JSON.parse(
    await boundedJson(
      lease.url,
      { tool: name, callId, args: omitNulls(args) },
      signal,
      lease.token,
      8 * 1024 * 1024,
    ),
  ) as { content?: unknown };
  if (
    !Array.isArray(result.content) ||
    result.content.some((block: unknown) => {
      if (!block || typeof block !== "object") return true;
      const b = block as Record<string, unknown>;
      return !(
        (b.type === "text" && typeof b.text === "string") ||
        (b.type === "image" &&
          typeof b.data === "string" &&
          typeof b.mimeType === "string" &&
          b.mimeType.startsWith("image/"))
      );
    })
  )
    throw new RuntimeError("unavailable", "Invalid desktop tool result");
  return {
    content: result.content as (TextContent | ImageContent)[],
    details: {},
  };
}
