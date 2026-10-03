import { createHash } from "node:crypto";

const element = ["element_index", "element_token", "snapshot_id"];
const point = ["x", "y"];
const keyTarget = [...element, ...point];
const fields: Record<string, readonly string[]> = {
  get_window_state: [
    "include_screenshot",
    "max_depth",
    "max_elements",
    "query",
  ],
  click: [...keyTarget, "button", "count", "modifier", "delivery_mode"],
  double_click: [...keyTarget, "delivery_mode"],
  right_click: [...keyTarget, "modifier", "delivery_mode"],
  drag: [
    "from_x",
    "from_y",
    "to_x",
    "to_y",
    "duration_ms",
    "steps",
    "button",
    "modifier",
    "delivery_mode",
  ],
  type_text: [...keyTarget, "text", "delivery_mode"],
  press_key: [...keyTarget, "key", "modifiers", "delivery_mode"],
  hotkey: [...keyTarget, "keys", "delivery_mode"],
  scroll: [...keyTarget, "direction", "amount", "by", "delivery_mode"],
  set_value: [...element, "value"],
  invoke_menu: ["path"],
  set_window_frame: ["x", "y", "width", "height"],
};
const desktopFields: Record<string, readonly string[]> = {
  get_desktop_state: [],
  click: [...point, "button", "count", "modifier", "delivery_mode"],
  drag: fields.drag!,
  type_text: [...point, "text", "delivery_mode"],
  press_key: [...point, "key", "modifiers", "delivery_mode"],
  hotkey: [...point, "keys", "delivery_mode"],
  scroll: [...point, "direction", "amount", "by", "delivery_mode"],
  move_cursor: point,
};
const required: Record<string, readonly string[]> = {
  drag: ["from_x", "from_y", "to_x", "to_y"],
  move_cursor: point,
  type_text: ["text"],
  press_key: ["key"],
  hotkey: ["keys"],
  scroll: ["direction"],
  set_value: ["value"],
  invoke_menu: ["path"],
  set_window_frame: ["x", "y", "width", "height"],
};
const numbers = new Set([
  "x",
  "y",
  "from_x",
  "from_y",
  "to_x",
  "to_y",
  "width",
  "height",
  "amount",
  "duration_ms",
]);
const integers = new Set([
  "element_index",
  "max_depth",
  "max_elements",
  "count",
  "steps",
]);
const arrays = new Set(["modifier", "modifiers", "keys", "path"]);

/**
 * Pinned cua-driver 0.23.2 capture and input surface. Owner is supplied by authenticated
 * server context, never request JSON. Browser and unknown tools need their
 * own binding and are rejected here. Desktop input is explicitly primary-output
 * scoped. The broker still owns one whole display;
 * this binding is not OS isolation or protection from out-of-band input.
 */
function bindRequest(
  kind: "window" | "desktop",
  owner: string,
  name: string,
  input: Record<string, unknown>,
) {
  if (typeof owner !== "string" || !owner.trim() || owner.length > 256)
    throw new Error("A bounded authenticated owner is required.");
  const toolFields = kind === "window" ? fields : desktopFields;
  if (!Object.hasOwn(toolFields, name))
    throw new Error(`Unsupported ${kind} tool.`);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Input arguments must be an object.");
  const allowed = new Set([
    ...(kind === "window" ? ["pid", "window_id"] : []),
    ...toolFields[name]!,
  ]);
  for (const key of Object.keys(input))
    if (!allowed.has(key))
      throw new Error(`Unsupported input argument: ${key}`);
  const args = structuredClone(input);
  const { pid, window_id: windowId } = args;
  if (
    kind === "window" &&
    (!Number.isSafeInteger(pid) ||
      Number(pid) < 1 ||
      Number(pid) > 0xffffffff ||
      !Number.isSafeInteger(windowId) ||
      Number(windowId) < 0)
  )
    throw new Error("An explicit valid pid and window_id are required.");
  for (const key of required[name] || [])
    if (!Object.hasOwn(args, key))
      throw new Error(`Missing input argument: ${key}`);
  for (const key of toolFields[name]!) {
    if (!Object.hasOwn(args, key)) continue;
    const value = args[key];
    if (numbers.has(key)) {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        (value < 0 && !(name === "set_window_frame" && point.includes(key)))
      )
        throw new Error(`Invalid numeric input argument: ${key}`);
    } else if (integers.has(key)) {
      if (
        !Number.isSafeInteger(value) ||
        Number(value) < (key === "element_index" ? 0 : 1)
      )
        throw new Error(`Invalid integer input argument: ${key}`);
    } else if (arrays.has(key)) {
      if (
        !Array.isArray(value) ||
        value.length > 100 ||
        value.some(
          (part) => typeof part !== "string" || !part || part.length > 1024,
        )
      )
        throw new Error(`Invalid list input argument: ${key}`);
    } else if (key === "include_screenshot") {
      if (value !== true) throw new Error("A screen image is required.");
    } else if (typeof value !== "string" || value.length > 1_048_576)
      throw new Error(`Invalid text input argument: ${key}`);
  }
  if (args.delivery_mode !== undefined && args.delivery_mode !== "foreground")
    throw new Error("Input requires foreground delivery.");
  if (
    args.duration_ms !== undefined &&
    (!Number.isInteger(args.duration_ms) || Number(args.duration_ms) > 10000)
  )
    throw new Error("Drag duration must be an integer at most 10000 ms.");
  if (args.steps !== undefined && Number(args.steps) > 200)
    throw new Error("Drag steps must be at most 200.");
  if (
    args.amount !== undefined &&
    (!Number.isInteger(args.amount) ||
      Number(args.amount) < 1 ||
      Number(args.amount) > 50)
  )
    throw new Error("Scroll amount must be an integer from 1 to 50.");
  if (args.by !== undefined && !["line", "page"].includes(String(args.by)))
    throw new Error("Invalid scroll unit.");
  if (name === "hotkey" && (args.keys as string[]).length < 2)
    throw new Error("A hotkey requires at least two keys.");
  if (
    name === "invoke_menu" &&
    ((args.path as string[]).length < 1 ||
      (args.path as string[]).length > 16 ||
      (args.path as string[]).some((part) => part.length > 200))
  )
    throw new Error("A menu path requires 1 to 16 bounded segments.");
  if (
    name === "set_window_frame" &&
    (Number(args.width) < 1 || Number(args.height) < 1)
  )
    throw new Error("Window dimensions must be positive.");
  if (
    ["set_window_frame", "invoke_menu"].includes(name) &&
    Number(windowId) < 1
  )
    throw new Error("This window action requires a positive window identity.");
  if (
    args.snapshot_id !== undefined &&
    !/^s[0-9a-f]{8}$/.test(String(args.snapshot_id))
  )
    throw new Error("Invalid snapshot identity.");
  if (args.element_index !== undefined && args.snapshot_id === undefined)
    throw new Error("Element indices require their matching snapshot.");
  if ((args.x === undefined) !== (args.y === undefined))
    throw new Error("Coordinates require both x and y.");
  if (
    ["click", "double_click", "right_click", "set_value"].includes(name) &&
    args.x === undefined &&
    args.element_index === undefined &&
    !args.element_token
  )
    throw new Error("An explicit element or point is required.");
  if (
    args.button !== undefined &&
    !["left", "right", "middle"].includes(String(args.button))
  )
    throw new Error("Invalid mouse button.");
  if (
    args.direction !== undefined &&
    !["up", "down", "left", "right"].includes(String(args.direction))
  )
    throw new Error("Invalid scroll direction.");
  const session = `mindi-${createHash("sha256").update(owner).digest("hex")}`;
  args.session = session;
  if (name === "get_window_state") args.include_screenshot = true;
  if (toolFields[name]!.includes("delivery_mode"))
    args.delivery_mode = "foreground";
  if (kind === "desktop" && name !== "get_desktop_state") {
    args.target = { kind: "desktop", display_id: "primary" };
  }
  return {
    scope: {
      owner,
      target: JSON.stringify(
        kind === "window"
          ? ["window", pid, windowId, session]
          : ["desktop", "primary", session],
      ),
    },
    args,
  };
}

/** Explicit window capture/input; never inferred from mutable display focus. */
export function bindWindowRequest(
  owner: string,
  name: string,
  input: Record<string, unknown>,
) {
  return bindRequest("window", owner, name, input);
}

/** The deployed driver supports primary-output capture only. No silent window fallback. */
export function bindDesktopRequest(
  owner: string,
  name: string,
  input: Record<string, unknown>,
) {
  return bindRequest("desktop", owner, name, input);
}
