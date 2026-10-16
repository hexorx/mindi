import { mkdir, open, readFile, rename, unlink, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import type {
  Credential,
  CredentialStore,
  AuthOperationOptions,
} from "@earendil-works/pi-ai";

/** Separate from OMP/Codex stores: one owner for each rotating refresh token. */
export class CoordinatorCredentialStore implements CredentialStore {
  private readonly directory: string;
  private readonly path: string;
  constructor(stateRoot: string) {
    this.directory = join(resolve(stateRoot), "coordinator-auth");
    this.path = join(this.directory, "openai-codex.json");
  }
  async read(
    providerId: string,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    if (providerId !== "openai-codex") return undefined;
    try {
      const value: unknown = JSON.parse(await readFile(this.path, "utf8"));
      if (value === null) return undefined;
      if (
        !value ||
        typeof value !== "object" ||
        !("type" in value) ||
        value.type !== "oauth" ||
        !("access" in value) ||
        typeof value.access !== "string" ||
        !value.access ||
        !("refresh" in value) ||
        typeof value.refresh !== "string" ||
        !value.refresh ||
        !("expires" in value) ||
        typeof value.expires !== "number" ||
        !Number.isFinite(value.expires)
      )
        throw new Error("Invalid coordinator subscription credential");
      return value as Credential;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(
        "Cannot read coordinator subscription credentials; run logout then login",
      );
    }
  }
  async list(options?: AuthOperationOptions) {
    return (await this.read("openai-codex", options))
      ? [{ providerId: "openai-codex", type: "oauth" as const }]
      : [];
  }
  private async locked<T>(
    fn: (assertOwned: () => void) => Promise<T>,
    options?: AuthOperationOptions,
  ): Promise<T> {
    options?.signal?.throwIfAborted();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    const deadline = Date.now() + 120000;
    let compromised = false;
    let release: (() => Promise<void>) | undefined;
    while (!release) {
      options?.signal?.throwIfAborted();
      try {
        release = await lockfile.lock(this.path, {
          realpath: false,
          stale: 120000,
          update: 10000,
          retries: 0,
          onCompromised: () => {
            compromised = true;
          },
        });
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ELOCKED" ||
          Date.now() >= deadline
        )
          throw new Error(
            "Coordinator credential store is busy or unavailable",
          );
        await delay(50, undefined, { signal: options?.signal });
      }
    }
    try {
      options?.signal?.throwIfAborted();
      // The callback must finish before releasing the refresh-token lock.
      const result = await fn(() => {
        if (compromised)
          throw new Error("Coordinator credential lock was lost");
      });
      if (compromised) throw new Error("Coordinator credential lock was lost");
      return result;
    } finally {
      await release();
    }
  }
  private async save(value: Credential | null) {
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      const directory = await open(this.directory, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    if (providerId !== "openai-codex")
      throw new Error("Only OpenAI subscription credentials are stored here");
    return this.locked(async (assertOwned) => {
      const current = await this.read(providerId, options);
      let next: Credential | undefined;
      try {
        next = await fn(current);
      } catch {
        // Upstream token errors may embed the entire response, including tokens.
        throw new Error(
          "Coordinator subscription refresh failed; log in again",
        );
      }
      // Persist successful rotation even if cancellation arrived during refresh.
      assertOwned();
      if (next !== undefined) await this.save(next);
      return next ?? current;
    }, options);
  }
  async delete(providerId: string, options?: AuthOperationOptions) {
    if (providerId !== "openai-codex") return;
    await this.locked(() => this.save(null), options);
  }
}
