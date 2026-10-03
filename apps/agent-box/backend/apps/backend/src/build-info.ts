import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";

export interface BackendBuildInfo {
  schemaVersion: 1;
  version: string;
  revision: string | null;
}
/** Package metadata is a report, not proof of registry or source-tree integrity. */
export function parseBuildInfo(value: unknown): BackendBuildInfo {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid backend build metadata");
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 3 ||
    row.schemaVersion !== 1 ||
    typeof row.version !== "string" ||
    row.version.length > 64 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      row.version,
    ) ||
    (row.revision !== null &&
      (typeof row.revision !== "string" ||
        !/^[a-f0-9]{40}$/.test(row.revision)))
  )
    throw Error("Invalid backend build metadata");
  return {
    schemaVersion: 1,
    version: row.version,
    revision: row.revision as string | null,
  };
}
export async function writeBuildInfo(
  path: string,
  version: string,
  revision: string,
): Promise<void> {
  const info = parseBuildInfo({
    schemaVersion: 1,
    version,
    revision: revision === "" ? null : revision,
  });
  await writeFile(path, JSON.stringify(info) + "\n", { mode: 0o644 });
}
export async function readPackagedBuildInfo(
  path: string | URL = new URL("../build-info.json", import.meta.url),
): Promise<BackendBuildInfo | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    if (!(await file.stat()).isFile()) return null;
    const bytes = Buffer.alloc(4097);
    const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 4096) return null;
    return parseBuildInfo(
      JSON.parse(bytes.subarray(0, result.bytesRead).toString("utf8")),
    );
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}
