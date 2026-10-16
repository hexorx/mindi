import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
} from "node:fs";
import { open, lstat, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import type { BigIntStats } from "node:fs";
export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const sameNode = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino;
const unchanged = (a: BigIntStats, b: BigIntStats) =>
  sameNode(a, b) &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.nlink === b.nlink;
/** Linux descriptor-relative capture. No pathname-open fallback on other hosts. */
export class ArtifactWorkspace {
  private root?: number;
  private identity?: BigIntStats;
  private readonly path: string;
  readonly unavailable?: string;
  constructor(workspace: string, expected?: { dev: string; ino: string }) {
    this.path = resolve(workspace);
    if (process.platform !== "linux") {
      this.unavailable =
        "Workspace acquisition requires Linux descriptor-relative filesystem access.";
      return;
    }
    try {
      if (realpathSync(this.path) !== this.path) throw Error();
      const before = lstatSync(this.path, { bigint: true });
      if (!before.isDirectory() || before.isSymbolicLink()) throw Error();
      this.root = openSync(
        this.path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      this.identity = fstatSync(this.root, { bigint: true });
      if (!sameNode(before, this.identity)) throw Error();
      if (
        expected &&
        (String(this.identity.dev) !== expected.dev ||
          String(this.identity.ino) !== expected.ino)
      )
        throw Error();
      // The descriptor filesystem is part of this implementation's required boundary.
      if (
        !sameNode(
          this.identity,
          lstatSync(`/proc/self/fd/${this.root}/.`, { bigint: true }),
        )
      )
        throw Error();
    } catch {
      this.close();
      this.unavailable =
        "Configured workspace is unavailable for confined acquisition.";
    }
  }
  private verifyRoot() {
    if (this.root === undefined || !this.identity)
      throw Error(this.unavailable || "Workspace acquisition is unavailable.");
    const current = lstatSync(this.path, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      !sameNode(current, this.identity) ||
      realpathSync(this.path) !== this.path
    )
      throw Error("Configured workspace root changed.");
    return this.root;
  }
  async capture(parts: string[]): Promise<Buffer> {
    if (this.unavailable) throw Error(this.unavailable);
    const handles: FileHandle[] = [];
    const links: { parent: number; name: string; identity: BigIntStats }[] = [];
    try {
      let parent = this.verifyRoot();
      for (const name of parts.slice(0, -1)) {
        const directory = await open(
          `/proc/self/fd/${parent}/${name}`,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        handles.push(directory);
        const identity = await directory.stat({ bigint: true });
        if (!identity.isDirectory()) throw Error();
        links.push({ parent, name, identity });
        parent = directory.fd;
      }
      const name = parts.at(-1)!;
      const file = await open(
        `/proc/self/fd/${parent}/${name}`,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      handles.push(file);
      const before = await file.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size > BigInt(MAX_ARTIFACT_BYTES)
      )
        throw Error();
      const bytes = Buffer.alloc(Number(before.size) + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (!read.bytesRead) break;
        offset += read.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (
        !unchanged(before, after) ||
        offset !== Number(before.size) ||
        offset > MAX_ARTIFACT_BYTES
      )
        throw Error();
      const currentFile = await lstat(`/proc/self/fd/${parent}/${name}`, {
        bigint: true,
      });
      if (!currentFile.isFile() || !unchanged(after, currentFile))
        throw Error();
      for (const link of links) {
        const current = await lstat(
          `/proc/self/fd/${link.parent}/${link.name}`,
          { bigint: true },
        );
        if (!current.isDirectory() || !sameNode(current, link.identity))
          throw Error();
      }
      this.verifyRoot();
      return bytes.subarray(0, offset);
    } catch {
      throw Error(
        "Workspace file is unavailable, unsafe, oversized, or changed during acquisition.",
      );
    } finally {
      await Promise.allSettled(
        handles.reverse().map((handle) => handle.close()),
      );
    }
  }
  close() {
    if (this.root !== undefined) {
      closeSync(this.root);
      this.root = undefined;
    }
  }
}
