import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  ConnectorError,
  type ConnectorAccountIdentity,
  type ConnectorBinding,
} from "./types.js";
import { binding, id, object } from "./validation.js";
import { telegramId, telegramTopicId } from "../telegram-routine-delivery.js";
import { discordId } from "../discord-routine-delivery.js";
export interface ConnectorAccountConfig extends ConnectorAccountIdentity {
  enabled: boolean;
  tokenFile: string;
}
export interface ConnectorConfig {
  accounts: ConnectorAccountConfig[];
  bindings: ConnectorBinding[];
}
function invalid(): never {
  throw new ConnectorError("invalid", "Invalid connector configuration");
}
export function parseConnectorConfig(
  input: unknown,
  base: string,
  profiles: readonly string[],
): ConnectorConfig {
  if (input === undefined) return { accounts: [], bindings: [] };
  const row = object(input, ["accounts", "bindings"]);
  if (
    !Array.isArray(row.accounts) ||
    row.accounts.length > 32 ||
    !Array.isArray(row.bindings) ||
    row.bindings.length > 128
  )
    invalid();
  const accounts: ConnectorAccountConfig[] = row.accounts.map((raw) => {
    const value = object(raw, [
      "provider",
      "accountId",
      "credentialGeneration",
      "enabled",
      "tokenFile",
    ]);
    if (value.provider !== "telegram" && value.provider !== "discord")
      invalid();
    if (
      typeof value.enabled !== "boolean" ||
      typeof value.tokenFile !== "string" ||
      !value.tokenFile.trim() ||
      value.tokenFile.length > 4096 ||
      Array.from(value.tokenFile).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      invalid();
    if (
      value.provider === "telegram"
        ? !telegramId(value.accountId, true)
        : !discordId(value.accountId)
    )
      invalid();
    return {
      provider: value.provider,
      accountId: value.accountId as string,
      credentialGeneration: id(value.credentialGeneration),
      enabled: value.enabled,
      tokenFile: resolve(base, value.tokenFile),
    };
  });
  if (
    new Set(accounts.map((a) => JSON.stringify([a.provider, a.accountId])))
      .size !== accounts.length
  )
    invalid();
  const bindings = row.bindings.map((raw) => {
    const b = binding(raw),
      account = accounts.find(
        (a) => a.provider === b.provider && a.accountId === b.accountId,
      );
    if (
      !account ||
      account.credentialGeneration !== b.credentialGeneration ||
      !profiles.includes(b.profileId) ||
      (b.enabled && !account.enabled)
    )
      invalid();
    let parts: unknown;
    try {
      parts = JSON.parse(b.conversationId);
    } catch {
      invalid();
    }
    if (!Array.isArray(parts) || JSON.stringify(parts) !== b.conversationId)
      invalid();
    if (b.provider === "telegram") {
      if (
        parts.length !== 3 ||
        parts[0] !== "telegram" ||
        parts[1] !== b.chatId ||
        !telegramId(b.chatId) ||
        (parts[2] !== null && !telegramTopicId(parts[2])) ||
        b.allowedUserIds.some((user) => !telegramId(user, true))
      )
        invalid();
    } else {
      if (
        parts.length !== 4 ||
        parts[0] !== "discord" ||
        parts[2] !== b.chatId ||
        !discordId(b.chatId) ||
        (parts[1] !== null && !discordId(parts[1])) ||
        (parts[3] !== null && !discordId(parts[3])) ||
        (parts[1] === null && parts[3] !== null) ||
        b.allowedUserIds.some((user) => !discordId(user))
      )
        invalid();
      if (parts[1] === null && b.allowedUserIds.length !== 1) invalid();
    }
    return b;
  });
  if (
    new Set(bindings.map((b) => b.id)).size !== bindings.length ||
    new Set(bindings.map((b) => b.channelId)).size !== bindings.length ||
    new Set(
      bindings.map((b) =>
        JSON.stringify([b.provider, b.accountId, b.conversationId]),
      ),
    ).size !== bindings.length
  )
    invalid();
  return { accounts, bindings };
}
/** Private credentials never become connector status or renderer configuration. */
export async function loadConnectorCredentials(
  config: ConnectorConfig,
  stateRoot: string,
): Promise<{ account: ConnectorAccountConfig; token: string }[]> {
  const result: { account: ConnectorAccountConfig; token: string }[] = [];
  for (const account of config.accounts.filter((a) => a.enabled)) {
    let file;
    try {
      file = await open(
        account.tokenFile,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const info = await file.stat();
      if (!info.isFile() || info.size > 16384) invalid();
      const bytes = Buffer.alloc(16385),
        read = await file.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead > 16384) invalid();
      const token = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes.subarray(0, read.bytesRead))
        .trim();
      if (
        !token ||
        token.length > 16384 ||
        (account.provider === "telegram"
          ? !/^\d+:[A-Za-z0-9_-]+$/.test(token)
          : /[^\x21-\x7e]/.test(token))
      )
        invalid();
      result.push({ account: structuredClone(account), token });
    } catch {
      throw new ConnectorError(
        "unavailable",
        "Connector credential is unavailable",
      );
    } finally {
      await file?.close();
    }
  }
  if (!result.length) return result;
  const db = new DatabaseSync(
    resolve(stateRoot, "connector-credential-generations.sqlite"),
  );
  try {
    db.exec(
      "PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS generations(provider TEXT NOT NULL,account_id TEXT NOT NULL,generation TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(provider,account_id,generation)) STRICT",
    );
    for (const { account, token } of result) {
      const fingerprint = createHash("sha256").update(token).digest("hex");
      const prior = db
        .prepare(
          "SELECT fingerprint FROM generations WHERE provider=? AND account_id=? AND generation=?",
        )
        .get(account.provider, account.accountId, account.credentialGeneration);
      if (prior && prior.fingerprint !== fingerprint)
        throw new ConnectorError(
          "conflict",
          "Connector token changed without a new credential generation",
        );
      db.prepare("INSERT OR IGNORE INTO generations VALUES(?,?,?,?)").run(
        account.provider,
        account.accountId,
        account.credentialGeneration,
        fingerprint,
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return result;
}
