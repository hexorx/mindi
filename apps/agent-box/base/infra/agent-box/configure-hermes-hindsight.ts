#!/usr/bin/env node
/** Idempotent Hermes Hindsight memory wiring (local_external to box s6). */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Env = Record<string, string | undefined>;

const MEMORY_BLOCK = `
memory:
  provider: hindsight
`;

function homeDir(env: Env): string {
  return env.HOME ?? "/home/agent";
}

function hermesHome(env: Env): string {
  return env.HERMES_HOME ?? `${homeDir(env)}/.hermes`;
}

function profileName(env: Env): string {
  return env.PERSONA_NAME || env.HERMES_PROFILE || "default";
}

export function hindsightConfig(apiUrl: string): string {
  return `${JSON.stringify(
    { mode: "local_external", api_url: apiUrl },
    null,
    2,
  )}\n`;
}

export function ensureMemoryProvider(text: string): string {
  if (/provider:\s*hindsight/.test(text)) {
    return text;
  }
  if (/^memory:\s*$/m.test(text) && /provider:/.test(text)) {
    return text.replace(/^(memory:[\s\S]*?provider:\s*)\S+/m, "$1hindsight");
  }
  if (/^memory:\s*$/m.test(text)) {
    return text.replace(/^memory:\s*$/m, "memory:\n  provider: hindsight");
  }
  return `${text.replace(/\s+$/, "")}\n${MEMORY_BLOCK}`;
}

export function writeHindsightConfig(path: string, apiUrl: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, hindsightConfig(apiUrl));
}

export function configureYaml(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, ensureMemoryProvider(text));
}

export function configureHermesHindsight(env: Env = process.env): void {
  const apiUrl = env.HINDSIGHT_API_URL ?? "http://127.0.0.1:8888";
  const root = hermesHome(env);
  const profile = profileName(env);
  writeHindsightConfig(`${root}/hindsight/config.json`, apiUrl);
  configureYaml(`${root}/config.yaml`);
  configureYaml(`${root}/profiles/${profile}/config.yaml`);
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
  configureHermesHindsight();
}
