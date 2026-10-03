import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
export type DesktopErrorCode =
  "invalid" | "not_found" | "conflict" | "unavailable" | "closed";
const messages: Record<DesktopErrorCode, string> = {
  invalid: "Invalid desktop input",
  not_found: "Desktop profile not found",
  conflict: "Desktop revision or ownership conflict",
  unavailable: "Desktop unavailable",
  closed: "Desktop settings are closed",
};
export class DesktopError extends Error {
  constructor(public readonly code: DesktopErrorCode) {
    super(messages[code]);
    this.name = "DesktopError";
  }
}
/** Prepare a private file without following a leaf symlink. Its parent must be owned and private. */
export function prepareDesktopDatabase(path: string): void {
  try {
    const parent = dirname(resolve(path));
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const info = lstatSync(parent);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      info.mode & 0o077
    )
      throw new DesktopError("unavailable");
    const fd = openSync(
      path,
      constants.O_CREAT |
        constants.O_RDWR |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    try {
      const file = fstatSync(fd);
      if (
        !file.isFile() ||
        file.nlink !== 1 ||
        file.uid !== process.getuid?.() ||
        file.mode & 0o077
      )
        throw new DesktopError("unavailable");
    } finally {
      closeSync(fd);
    }
  } catch {
    throw new DesktopError("unavailable");
  }
}
export interface DesktopSetting {
  profileId: string;
  enabled: boolean;
  revision: number;
}
export class DesktopSettings {
  private db: DatabaseSync;
  private closed = false;
  private validateProfile: (id: string) => void;
  constructor(options: {
    databasePath: string;
    validateProfile: (id: string) => void;
  }) {
    this.validateProfile = options.validateProfile;
    prepareDesktopDatabase(options.databasePath);
    try {
      this.db = new DatabaseSync(options.databasePath);
    } catch {
      throw new DesktopError("unavailable");
    }
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
      this.atomic(() => {
        const version = this.db.prepare("PRAGMA user_version").get()!
          .user_version;
        if (version !== 0 && version !== 1)
          throw new DesktopError("unavailable");
        this.db.exec(
          "CREATE TABLE IF NOT EXISTS desktop_settings(profile_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), revision INTEGER NOT NULL CHECK(revision>=2)); PRAGMA user_version=1;",
        );
      });
    } catch {
      this.db.close();
      throw new DesktopError("unavailable");
    }
  }
  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  private check(): void {
    if (this.closed) throw new DesktopError("closed");
  }
  private validate(id: string): void {
    this.check();
    if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(id))
      throw new DesktopError("invalid");
    try {
      this.validateProfile(id);
    } catch {
      throw new DesktopError("not_found");
    }
  }
  private atomic<T>(run: () => T): T {
    this.check();
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch {
      throw new DesktopError("unavailable");
    }
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      if (error instanceof DesktopError) throw error;
      throw new DesktopError("unavailable");
    }
  }
  get(profileId: string): DesktopSetting {
    this.validate(profileId);
    try {
      const row = this.db
        .prepare(
          "SELECT enabled,revision FROM desktop_settings WHERE profile_id=?",
        )
        .get(profileId);
      return {
        profileId,
        enabled: row?.enabled === 1,
        revision: row ? Number(row.revision) : 1,
      };
    } catch {
      throw new DesktopError("unavailable");
    }
  }
  update(
    profileId: string,
    input: { expectedRevision: number; enabled: boolean },
  ): DesktopSetting {
    this.check();
    if (
      !input ||
      typeof input !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
      Reflect.ownKeys(input).some(
        (key) =>
          typeof key !== "string" ||
          !["expectedRevision", "enabled"].includes(key) ||
          !("value" in Object.getOwnPropertyDescriptor(input, key)!),
      ) ||
      typeof input.enabled !== "boolean" ||
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 1 ||
      input.expectedRevision >= Number.MAX_SAFE_INTEGER
    )
      throw new DesktopError("invalid");
    return this.atomic(() => {
      const current = this.get(profileId);
      if (current.revision !== input.expectedRevision)
        throw new DesktopError("conflict");
      const next = {
        profileId,
        enabled: input.enabled,
        revision: current.revision + 1,
      };
      this.db
        .prepare(
          "INSERT INTO desktop_settings(profile_id,enabled,revision) VALUES(?,?,?) ON CONFLICT(profile_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision",
        )
        .run(profileId, Number(next.enabled), next.revision);
      return next;
    });
  }
}
