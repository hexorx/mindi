#!/usr/bin/env node
/** Idempotent Hermes Buzz native-platform wiring from compose-seeded env. */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Env = Record<string, string | undefined>;

function homeDir(env: Env): string {
  return env.HOME ?? "/home/agent";
}

function hermesHome(env: Env): string {
  return env.HERMES_HOME ?? `${homeDir(env)}/.hermes`;
}

function profileName(env: Env): string {
  return env.PERSONA_NAME || env.HERMES_PROFILE || "default";
}

export function buzzYaml(relay: string): string {
  const extra = [
    "        require_mention: true",
    "        allow_all_users: false",
    "        poll_interval: 4",
  ];
  if (relay) {
    extra.unshift(`        relay_url: "${relay}"`);
  }
  return `
display:
  platforms:
    buzz:
      interim_assistant_messages: false
      tool_progress: off
gateway:
  platforms:
    buzz:
      enabled: true
      extra:
${extra.join("\n")}
`;
}

export function upsertEnv(path: string, updates: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\n/) : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const stripped = line.trim();
    if (stripped && !stripped.startsWith("#") && line.includes("=")) {
      const name = line.slice(0, line.indexOf("=")).trim();
      if (name in updates) {
        out.push(`${name}=${updates[name]}`);
        seen.add(name);
        continue;
      }
    }
    out.push(line);
  }
  for (const [name, value] of Object.entries(updates)) {
    if (!seen.has(name)) {
      out.push(`${name}=${value}`);
    }
  }
  writeFileSync(path, `${out.join("\n")}\n`);
  chmodSync(path, 0o600);
}

export function ensureBuzzYaml(path: string, relay: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (text.includes("buzz:")) {
    return;
  }
  writeFileSync(
    path,
    `${text.replace(/\s+$/, "")}\n${buzzYaml(relay).replace(/^\s+/, "")}`,
  );
}

export function setBuzzRelayUrl(path: string, relay: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    ensureBuzzYaml(path, relay);
    return;
  }
  const text = readFileSync(path, "utf8");
  if (!text.includes("buzz:")) {
    ensureBuzzYaml(path, relay);
    return;
  }
  if (/relay_url:/.test(text)) {
    writeFileSync(
      path,
      text.replace(/^(\s*relay_url:\s*).+$/m, `$1"${relay}"`),
    );
    return;
  }
  if (/^\s*extra:\s*$/m.test(text)) {
    writeFileSync(
      path,
      text.replace(/^(\s*extra:\s*)$/m, `$1\n        relay_url: "${relay}"`),
    );
    return;
  }
}

export function configureHermesBuzz(env: Env = process.env): void {
  const key = env.BUZZ_PRIVATE_KEY ?? "";
  const relay = env.BUZZ_RELAY_URL ?? "";
  const updates: Record<string, string> = {};
  if (key) updates.BUZZ_PRIVATE_KEY = key;
  if (relay) updates.BUZZ_RELAY_URL = relay;
  if (Object.keys(updates).length === 0) {
    return;
  }
  const root = hermesHome(env);
  const profile = profileName(env);
  upsertEnv(`${root}/.env`, updates);
  upsertEnv(`${root}/profiles/${profile}/.env`, updates);
  ensureBuzzYaml(`${root}/config.yaml`, relay);
  ensureBuzzYaml(`${root}/profiles/${profile}/config.yaml`, relay);
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
  configureHermesBuzz();
}
