import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  RoutineDeliveryRegistry,
  type DeliveryAddress,
  type RoutineDeliveryAdapter,
} from "@mindi/routines";
import { createSlackDeliveryAdapter } from "./slack-routine-delivery.js";
import {
  createDiscordDeliveryAdapter,
  discordId,
  discordForumTags,
  discordDmRecipients,
  type DiscordDeliveryConfig,
} from "./discord-routine-delivery.js";
import {
  createTelegramDeliveryAdapter,
  telegramId,
  telegramTopicId,
  type TelegramDeliveryConfig,
} from "./telegram-routine-delivery.js";
export type RoutineDeliveryConfig =
  SlackDeliveryConfig | DiscordDeliveryConfig | TelegramDeliveryConfig;
export interface SlackDeliveryConfig {
  id: string;
  revision: number;
  platform: "slack";
  profileIds: string[];
  teamId: string;
  userId: string;
  tokenFile: string;
  home?: DeliveryAddress;
  aliases?: Record<string, DeliveryAddress>;
}
function invalid(): never {
  throw new Error("Invalid routine delivery configuration");
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 1024): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    Array.from(value).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  )
    invalid();
  return value;
}
function address(
  value: unknown,
  platform: "slack" | "discord" | "telegram",
): DeliveryAddress {
  const row = object(value, ["chatId", "threadId"]);
  const chatId = string(row.chatId);
  if (
    platform === "telegram"
      ? !telegramId(chatId)
      : platform === "discord"
        ? !discordId(chatId)
        : !/^[CGDUW][A-Z0-9]{2,63}$/.test(chatId)
  )
    invalid();
  const threadId =
    row.threadId === undefined ? undefined : string(row.threadId);
  if (
    threadId &&
    (platform === "telegram"
      ? !telegramTopicId(threadId)
      : platform === "discord"
        ? !discordId(threadId)
        : !/^\d{10,20}\.\d{6}$/.test(threadId))
  )
    invalid();
  if (platform === "slack" && /^[UW]/.test(chatId) && threadId) invalid();
  return { chatId, ...(threadId ? { threadId } : {}) };
}
export function parseRoutineDeliveryConfig(
  value: unknown,
  base: string,
  profiles?: readonly string[],
): RoutineDeliveryConfig[] {
  if (!Array.isArray(value) || value.length > 64) invalid();
  const result: RoutineDeliveryConfig[] = value.map(
    (raw): RoutineDeliveryConfig => {
      const row = object(raw, [
        "id",
        "revision",
        "platform",
        "profileIds",
        "teamId",
        "guildId",
        "userId",
        "tokenFile",
        "home",
        "aliases",
        "forumTags",
        "dmRecipients",
      ]);
      if (
        (row.platform !== "slack" &&
          row.platform !== "discord" &&
          row.platform !== "telegram") ||
        !Number.isSafeInteger(row.revision) ||
        (row.revision as number) < 1
      )
        invalid();
      if (
        !Array.isArray(row.profileIds) ||
        row.profileIds.length > 32 ||
        row.profileIds.some(
          (p) =>
            typeof p !== "string" ||
            !/^[a-z][a-z0-9_-]{0,63}$/.test(p) ||
            (profiles !== undefined && !profiles.includes(p)),
        ) ||
        new Set(row.profileIds).size !== row.profileIds.length
      )
        invalid();
      const platform = row.platform as "slack" | "discord" | "telegram";
      if (row.forumTags !== undefined && platform !== "discord") invalid();
      if (row.dmRecipients !== undefined && platform !== "discord") invalid();
      const dmRecipients =
        row.dmRecipients === undefined
          ? undefined
          : discordDmRecipients(row.dmRecipients);
      const forumTags =
        row.forumTags === undefined
          ? undefined
          : discordForumTags(row.forumTags);
      const userId = string(row.userId, 64);
      const identity =
        platform === "slack"
          ? { teamId: string(row.teamId, 64) }
          : platform === "discord"
            ? {
                guildId:
                  row.guildId === undefined
                    ? undefined
                    : string(row.guildId, 64),
              }
            : {};
      if (platform === "slack") {
        if (
          row.guildId !== undefined ||
          !/^T[A-Z0-9]{2,63}$/.test(identity.teamId!) ||
          !/^[UW][A-Z0-9]{2,63}$/.test(userId)
        )
          invalid();
      } else if (platform === "telegram") {
        if (
          row.teamId !== undefined ||
          row.guildId !== undefined ||
          !telegramId(userId, true)
        )
          invalid();
      } else if (
        row.teamId !== undefined ||
        (identity.guildId === undefined
          ? !Object.keys(dmRecipients ?? {}).length
          : !discordId(identity.guildId)) ||
        !discordId(userId)
      )
        invalid();
      let aliases: Record<string, DeliveryAddress> | undefined;
      if (row.aliases !== undefined) {
        if (
          !row.aliases ||
          typeof row.aliases !== "object" ||
          Array.isArray(row.aliases) ||
          Object.keys(row.aliases).length > 128
        )
          invalid();
        aliases = Object.fromEntries(
          Object.entries(row.aliases).map(([key, value]) => {
            if (
              !key.trim() ||
              key.length > 128 ||
              key.includes(",") ||
              key.includes(":") ||
              key !== key.trim()
            )
              invalid();
            string(key);
            return [key, address(value, platform)];
          }),
        );
      }
      return {
        id: string(row.id, 128),
        revision: row.revision as number,
        ...(platform === "slack"
          ? { platform: "slack" as const, teamId: identity.teamId! }
          : platform === "discord"
            ? { platform: "discord" as const, guildId: identity.guildId }
            : { platform: "telegram" as const }),
        profileIds: [...row.profileIds] as string[],
        userId,
        tokenFile: resolve(base, string(row.tokenFile)),
        ...(row.home === undefined
          ? {}
          : { home: address(row.home, platform) }),
        ...(aliases ? { aliases } : {}),
        ...(forumTags ? { forumTags } : {}),
        ...(dmRecipients ? { dmRecipients } : {}),
      };
    },
  );
  new RoutineDeliveryRegistry(
    result.map(({ id, revision, platform, profileIds, home }) => ({
      id,
      revision,
      platform,
      profileIds,
      home,
    })),
  );
  return result;
}
/** Token rotation is allowed for the same verified account; identity/grant/target
 * changes require a new generation. No credential is stored in this manifest. */
export async function loadRoutineDeliveryAdapters(
  config: readonly RoutineDeliveryConfig[],
  stateRoot: string,
  activeProfiles?: readonly string[],
): Promise<RoutineDeliveryAdapter[]> {
  if (!config.length) return [];
  const adapters: RoutineDeliveryAdapter[] = [];
  for (const row of config) {
    if (
      activeProfiles &&
      !row.profileIds.some((id) => activeProfiles.includes(id))
    )
      continue;
    let file;
    try {
      file = await open(
        row.tokenFile,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const info = await file.stat();
      if (!info.isFile() || info.size > 16384) invalid();
      const buffer = Buffer.alloc(16385);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 16384) invalid();
      const token = buffer.subarray(0, bytesRead).toString("utf8").trim();
      adapters.push(
        row.platform === "slack"
          ? createSlackDeliveryAdapter(row, token)
          : row.platform === "discord"
            ? createDiscordDeliveryAdapter(row, token)
            : createTelegramDeliveryAdapter(row, token),
      );
    } catch {
      throw new Error("Routine delivery credential is unavailable");
    } finally {
      await file?.close();
    }
  }
  const db = new DatabaseSync(
    resolve(stateRoot, "routine-delivery-bindings.sqlite"),
  );
  try {
    db.exec(
      "PRAGMA synchronous=FULL; BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS generations(id TEXT NOT NULL,revision INTEGER NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(id,revision))",
    );
    for (const row of config) {
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            id: row.id,
            platform: row.platform,
            ...(row.platform === "slack"
              ? { teamId: row.teamId }
              : row.platform === "discord"
                ? { guildId: row.guildId }
                : {}),
            ...(row.platform === "discord" && row.forumTags !== undefined
              ? { forumTags: discordForumTags(row.forumTags) }
              : {}),
            ...(row.platform === "discord" && row.dmRecipients !== undefined
              ? { dmRecipients: discordDmRecipients(row.dmRecipients) }
              : {}),
            userId: row.userId,
            profileIds: [...row.profileIds].sort(),
            home: row.home ?? null,
            aliases: Object.entries(row.aliases ?? {}).sort(([a], [b]) =>
              a < b ? -1 : a > b ? 1 : 0,
            ),
          }),
        )
        .digest("hex");
      const previous = db
        .prepare(
          "SELECT fingerprint FROM generations WHERE id=? AND revision=?",
        )
        .get(row.id, row.revision);
      if (previous && previous.fingerprint !== fingerprint)
        throw new Error(
          "Routine delivery binding changed without a new revision",
        );
      db.prepare("INSERT OR IGNORE INTO generations VALUES(?,?,?)").run(
        row.id,
        row.revision,
        fingerprint,
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  return adapters;
}
