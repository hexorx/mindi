import { createHash } from "node:crypto";
import { constants, lstatSync, realpathSync } from "node:fs";
import { lstat, open, readdir, rm } from "node:fs/promises";
import { connect } from "node:net";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { DesktopError, prepareDesktopDatabase } from "./settings.js";
const ownershipIdentities = new Set<string>();
function fileIdentities(path: string): string[] {
  try {
    const info = lstatSync(path);
    if (!info.isFile()) throw new DesktopError("unavailable");
    return [`path:${realpathSync(path)}`, `inode:${info.dev}:${info.ino}`];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return [`path:${resolve(path)}`];
    throw new DesktopError("unavailable");
  }
}
/** A separate rollback-journal database holds a lifetime OS-backed exclusive lock. */
export function acquireDesktopOwnership(path: string): () => void {
  // POSIX closes release this process's fcntl locks for that inode, even when
  // the descriptor belongs to another connection. Reject aliases before the
  // path preparation helper can open and close the active ownership file.
  if (fileIdentities(path).some((key) => ownershipIdentities.has(key)))
    throw new DesktopError("conflict");
  prepareDesktopDatabase(path);
  const identities = fileIdentities(path);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch {
    throw new DesktopError("unavailable");
  }
  try {
    db.exec(
      "PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE",
    );
  } catch (error) {
    db.close();
    if (
      (error as { errcode?: number }).errcode === 5 ||
      (error as { errcode?: number }).errcode === 6
    )
      throw new DesktopError("conflict");
    throw new DesktopError("unavailable");
  }
  for (const key of identities) ownershipIdentities.add(key);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      db.exec("ROLLBACK");
    } finally {
      try {
        db.close();
      } finally {
        for (const key of identities) ownershipIdentities.delete(key);
      }
    }
  };
}
function socketLive(path: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const client = connect(path);
    client.setTimeout(250);
    client.once("connect", () => {
      client.destroy();
      resolve(true);
    });
    client.once("timeout", () => {
      client.destroy();
      resolve(true);
    });
    client.once("error", (error: NodeJS.ErrnoException) => {
      client.destroy();
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED")
        resolve(false);
      else reject(new DesktopError("unavailable"));
    });
  });
}
async function privateDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    info.mode & 0o077
  )
    throw new DesktopError("unavailable");
}
async function owned(directory: string, name: string): Promise<boolean> {
  try {
    await privateDirectory(directory);
    const file = await open(
      join(directory, ".desktop-owner.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let owner;
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077 ||
        info.size > 16384
      )
        return false;
      const buffer = Buffer.alloc(16385);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16384) return false;
      owner = JSON.parse(buffer.subarray(0, bytesRead).toString());
    } finally {
      await file.close();
    }
    return (
      owner?.version === 1 &&
      typeof owner.profileId === "string" &&
      /^[a-z][a-z0-9_-]{0,63}$/.test(owner.profileId) &&
      typeof owner.generation === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        owner.generation,
      ) &&
      name ===
        `${createHash("sha256").update(owner.profileId).digest("hex").slice(0, 12)}-${owner.generation.slice(0, 8)}`
    );
  } catch {
    return false;
  }
}
async function hasLiveSocket(directory: string): Promise<boolean> {
  let live = false;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isSymbolicLink()) throw new DesktopError("unavailable");
    if (item.isSocket() && (await socketLive(path))) live = true;
    if (item.isDirectory() && (await hasLiveSocket(path))) live = true;
  }
  return live;
}
/** Caller must hold ownership. Never signal stale PIDs or remove unrecognized records. */
export async function recoverDesktopRuntime(
  root: string,
  waitMs = 5000,
): Promise<void> {
  try {
    if (!Number.isFinite(waitMs) || waitMs < 0)
      throw new DesktopError("invalid");
    await privateDirectory(root);
    for (const item of await readdir(root, { withFileTypes: true })) {
      if (!item.isDirectory() || !/^[a-f0-9]{12}-[a-f0-9]{8}$/.test(item.name))
        continue;
      const directory = join(root, item.name);
      if (!(await owned(directory, item.name)))
        throw new DesktopError("unavailable");
      const deadline = Date.now() + waitMs;
      while (await hasLiveSocket(directory)) {
        if (Date.now() >= deadline) throw new DesktopError("unavailable");
        await delay(Math.min(50, Math.max(0, deadline - Date.now())));
      }
      if (!(await owned(directory, item.name)))
        throw new DesktopError("unavailable");
      await rm(directory, { recursive: true, force: true });
    }
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError("unavailable");
  }
}
