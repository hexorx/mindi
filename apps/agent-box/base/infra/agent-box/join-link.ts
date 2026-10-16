#!/usr/bin/env node
/** Parse a /join link and persist a Buzz relay (claiming invites when possible). */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  configureHermesBuzz,
  setBuzzRelayUrl,
  upsertEnv,
} from "./configure-hermes-buzz.ts";

export type Env = Record<string, string | undefined>;

export type JoinTarget =
  | { kind: "invite"; relay: string; code: string }
  | { kind: "relay"; relay: string }
  | { kind: "unsupported"; platform: string; message: string }
  | { kind: "unknown"; message: string };

export type JoinResult = { ok: boolean; message: string };

export type JoinDeps = {
  claim?: (relay: string, code: string) => { ok: boolean; detail: string };
};

function strip(raw: string): string {
  return raw
    .trim()
    .replace(/^<(.+)>$/s, "$1")
    .replace(/^`(.+)`$/s, "$1")
    .trim();
}

function originOf(url: URL): string {
  return url.origin.replace(/\/+$/, "");
}

function asRelay(url: URL): string {
  if (url.protocol === "ws:" || url.protocol === "wss:") {
    return `${url.protocol}//${url.host}`;
  }
  return originOf(url);
}

export function parseJoinLink(raw: string): JoinTarget {
  const text = strip(raw);
  if (!text) {
    return { kind: "unknown", message: "Usage: /join <invite-or-relay-link>" };
  }

  const lower = text.toLowerCase();
  if (
    lower.includes("t.me/") ||
    lower.includes("telegram.me/") ||
    lower.startsWith("tg:")
  ) {
    return {
      kind: "unsupported",
      platform: "telegram",
      message:
        "Telegram invite links cannot be claimed by the box. Add the bot to the chat from Telegram.",
    };
  }
  if (lower.includes("discord.gg/") || lower.includes("discord.com/invite")) {
    return {
      kind: "unsupported",
      platform: "discord",
      message:
        "Discord invite links cannot be claimed by the box. Invite the bot from Discord.",
    };
  }

  if (/^v2\./i.test(text) || /^eyJ[A-Za-z0-9_-]+/.test(text)) {
    return { kind: "invite", relay: "", code: text };
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return {
      kind: "unknown",
      message: "Not a Buzz invite or relay URL. Paste the full invite link.",
    };
  }

  const code =
    url.searchParams.get("invite") ||
    url.searchParams.get("code") ||
    url.searchParams.get("token") ||
    "";
  const parts = url.pathname.split("/").filter(Boolean);
  const inviteIdx = parts.findIndex((p) => p === "invite" || p === "join");
  const pathCode =
    inviteIdx >= 0 && parts[inviteIdx + 1] ? parts[inviteIdx + 1] : "";
  const token = decodeURIComponent(code || pathCode);
  if (token) {
    return { kind: "invite", relay: asRelay(url), code: token };
  }
  if (["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
    return { kind: "relay", relay: asRelay(url) };
  }
  return {
    kind: "unknown",
    message: "Not a Buzz invite or relay URL. Paste the full invite link.",
  };
}

function homeDir(env: Env): string {
  return env.HOME ?? "/home/agent";
}

function hermesHome(env: Env): string {
  return env.HERMES_HOME ?? `${homeDir(env)}/.hermes`;
}

function profileName(env: Env): string {
  return env.PERSONA_NAME || env.HERMES_PROFILE || "default";
}

function persistRelay(env: Env, relay: string): void {
  configureHermesBuzz({ ...env, BUZZ_RELAY_URL: relay });
  const root = hermesHome(env);
  const profile = profileName(env);
  setBuzzRelayUrl(`${root}/config.yaml`, relay);
  setBuzzRelayUrl(`${root}/profiles/${profile}/config.yaml`, relay);
  upsertEnv(`${root}/.env`, { BUZZ_RELAY_URL: relay });
  upsertEnv(`${root}/profiles/${profile}/.env`, { BUZZ_RELAY_URL: relay });
  const dest = env.BUZZ_RELAY_URL_PATH || `${homeDir(env)}/.secrets/buzz-relay`;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, relay);
  chmodSync(dest, 0o600);
  const runtime = env.AGENT_BOX_ENV_PATH || "/run/agent-box.env";
  if (existsSync(runtime)) {
    upsertEnv(runtime, { BUZZ_RELAY_URL: relay });
  }
}

function defaultClaim(
  env: Env,
  relay: string,
  code: string,
): { ok: boolean; detail: string } {
  const result = spawnSync("buzz", ["invites", "claim", "--code", code], {
    encoding: "utf8",
    env: { ...process.env, ...env, BUZZ_RELAY_URL: relay },
  });
  const detail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (result.status === 0) {
    return { ok: true, detail: detail || "joined" };
  }
  if (result.error?.message.includes("ENOENT")) {
    return {
      ok: false,
      detail:
        "buzz CLI is not on PATH; relay was not claimed. Invite this npub from the Buzz app.",
    };
  }
  return { ok: false, detail: detail || "buzz invites claim failed" };
}

export function applyJoin(
  target: JoinTarget,
  env: Env = process.env,
  deps: JoinDeps = {},
): JoinResult {
  if (target.kind === "unsupported" || target.kind === "unknown") {
    return { ok: false, message: target.message };
  }
  if (!env.BUZZ_PRIVATE_KEY) {
    return {
      ok: false,
      message:
        "This box has no Buzz identity. Run scripts/setup-agent-box-env.sh first.",
    };
  }

  if (target.kind === "relay") {
    persistRelay(env, target.relay);
    return {
      ok: true,
      message: `Saved Buzz relay ${target.relay}. Restart the gateway (/gateway restart) to connect.`,
    };
  }

  const relay = target.relay || env.BUZZ_RELAY_URL || "";
  if (!relay) {
    return {
      ok: false,
      message:
        "That looks like an invite code. Paste the full invite link so the box knows which relay to join.",
    };
  }
  const claim = deps.claim ?? ((r, c) => defaultClaim(env, r, c));
  const claimed = claim(relay, target.code);
  if (!claimed.ok) {
    return { ok: false, message: claimed.detail };
  }
  persistRelay(env, relay);
  return {
    ok: true,
    message: `Joined ${relay} (${claimed.detail}). Restart the gateway (/gateway restart) to connect.`,
  };
}

function invokedAsCli(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(resolve(entry))
    );
  } catch {
    return false;
  }
}

if (invokedAsCli()) {
  const raw = process.argv.slice(2).join(" ");
  const result = applyJoin(parseJoinLink(raw));
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}
