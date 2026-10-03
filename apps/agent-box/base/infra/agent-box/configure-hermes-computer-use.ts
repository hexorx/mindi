#!/usr/bin/env node
/** Enable Hermes computer_use (cua-driver) on the agent-box profile. */

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

const TOOLSET_ITEM = "  - computer_use";
const BLOCK = `
computer_use:
  grant_existing_profile: true
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

export function hasToolset(text: string): boolean {
  return /^\s*-\s+computer_use\s*$/m.test(text);
}

export function ensureToolset(text: string): string {
  if (hasToolset(text)) {
    return text;
  }
  if (/^toolsets:\s*$/m.test(text)) {
    return text.replace(/^toolsets:\s*$/m, `toolsets:\n${TOOLSET_ITEM}`);
  }
  if (/^toolsets:\s*\n/m.test(text)) {
    return text.replace(/^toolsets:\s*\n/m, `toolsets:\n${TOOLSET_ITEM}\n`);
  }
  return `${text.replace(/\s+$/, "")}\n\ntoolsets:\n${TOOLSET_ITEM}\n`;
}

export function ensureBlock(text: string): string {
  if (/^computer_use:\s*$/m.test(text)) {
    return text;
  }
  return `${text.replace(/\s+$/, "")}\n${BLOCK}`;
}

export function configure(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, ensureBlock(ensureToolset(text)));
}

export function configureHermesComputerUse(env: Env = process.env): void {
  const root = hermesHome(env);
  const profile = profileName(env);
  configure(`${root}/config.yaml`);
  configure(`${root}/profiles/${profile}/config.yaml`);
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
  configureHermesComputerUse();
}
