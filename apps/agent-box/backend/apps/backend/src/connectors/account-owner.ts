import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConnectorError, type ConnectorProvider } from "./types.js";
import { id } from "./validation.js";

/**
 * A dedicated SQLite write transaction is an OS-released account lock.
 * Cursor/inbox writes use a separate database: ownership never delays durable input.
 * There is no timeout-based takeover of a receiver that might still be running.
 */
export class ConnectorAccountOwner {
  private readonly db: DatabaseSync;
  private closed = false;
  private readonly identity: string;
  constructor(options: {
    stateRoot: string;
    provider: ConnectorProvider;
    accountId: string;
  }) {
    if (options.provider !== "telegram" && options.provider !== "discord")
      throw new ConnectorError("invalid", "Invalid receiver provider");
    const key = createHash("sha256")
      .update(JSON.stringify([options.provider, id(options.accountId)]))
      .digest("hex");
    this.identity = key;
    const directory = join(options.stateRoot, "connector-owners");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, `${key}.sqlite`));
    try {
      this.db.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE;");
    } catch (error) {
      this.db.close();
      if (
        error instanceof Error &&
        "errcode" in error &&
        (error.errcode === 5 || error.errcode === 6)
      )
        throw new ConnectorError(
          "conflict",
          "Connector account is already owned",
        );
      throw new ConnectorError(
        "unavailable",
        "Cannot acquire connector account ownership",
      );
    }
  }
  assertOwned(scope?: {
    provider: ConnectorProvider;
    accountId: string;
  }): void {
    if (this.closed)
      throw new ConnectorError(
        "unavailable",
        "Connector account owner is closed",
      );
    if (
      scope &&
      createHash("sha256")
        .update(JSON.stringify([scope.provider, id(scope.accountId)]))
        .digest("hex") !== this.identity
    ) {
      throw new ConnectorError("conflict", "Connector owner identity mismatch");
    }
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      // Database close rolls back the held transaction and releases its OS lock.
      this.db.close();
    }
  }
}
