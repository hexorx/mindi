import { RuntimeError } from "./types.js";
export interface TaskOutputScope {
  profileId: string;
  threadId: string;
  runId: string;
  taskId: string;
  attemptId: string;
}
export interface TaskOutputMetadata {
  id: string;
  scope: TaskOutputScope;
  name: string;
  size: number;
  sha256: string;
  mediaType: string;
}
export interface TaskOutputAcquisition {
  prepare(scope: TaskOutputScope, signal: AbortSignal): Promise<string>;
  acquire(
    scope: TaskOutputScope,
    paths: readonly string[],
    signal: AbortSignal,
  ): Promise<TaskOutputMetadata[]>;
}
function fail(): never {
  throw new RuntimeError(
    "invalid",
    "Invalid task output report or acquisition",
  );
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((key) => !descriptors[key] || !("value" in descriptors[key]!))
  )
    fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    !!value.trim() &&
    value.length <= max &&
    !Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  );
}
function dataArray(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    !value.length ||
    value.length > 16
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== value.length + 1 ||
    Array.from({ length: value.length }, (_, i) => String(i)).some(
      (key) => !descriptors[key] || !("value" in descriptors[key]!),
    )
  )
    fail();
  return value;
}
export function taskOutputPaths(value: unknown): string[] {
  const values = dataArray(value);
  if (new Set(values).size !== values.length) fail();
  return values.map((path) => {
    if (
      !text(path, 2048) ||
      path.includes("\\") ||
      path.includes(":") ||
      path
        .split("/")
        .some(
          (p) => !p || p === "." || p === ".." || Buffer.byteLength(p) > 255,
        )
    )
      fail();
    return path;
  });
}
export function taskOutputManifest(
  value: unknown,
  scope: TaskOutputScope,
): TaskOutputMetadata[] {
  const values = dataArray(value);
  let total = 0;
  const ids = new Set<string>();
  return values.map((item) => {
    const row = object(item, [
      "id",
      "scope",
      "name",
      "size",
      "sha256",
      "mediaType",
    ]);
    const owner = object(row.scope, [
      "profileId",
      "threadId",
      "runId",
      "taskId",
      "attemptId",
    ]);
    if (
      Object.entries(scope).some(([key, value]) => owner[key] !== value) ||
      !text(row.id, 200) ||
      ids.has(row.id) ||
      !text(row.name, 255) ||
      /[\\/]/.test(row.name) ||
      row.name === "." ||
      row.name === ".." ||
      Buffer.byteLength(row.name) > 255 ||
      !Number.isSafeInteger(row.size) ||
      Number(row.size) < 0 ||
      Number(row.size) > 4194304 ||
      typeof row.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.sha256) ||
      !text(row.mediaType, 128) ||
      !/^[-\w.+]+\/[-\w.+]+$/.test(row.mediaType)
    )
      fail();
    total += Number(row.size);
    if (total > 16777216) fail();
    ids.add(row.id);
    return {
      id: row.id,
      scope: { ...scope },
      name: row.name as string,
      size: Number(row.size),
      sha256: row.sha256,
      mediaType: row.mediaType,
    };
  });
}

export function admittedTaskOutputs(
  value: unknown,
  scope: TaskOutputScope,
  paths: readonly string[],
): TaskOutputMetadata[] {
  const outputs = taskOutputManifest(value, scope);
  if (
    outputs.length !== paths.length ||
    outputs.some(
      (output, index) => output.name !== paths[index]!.split("/").at(-1),
    )
  )
    fail();
  return outputs;
}
