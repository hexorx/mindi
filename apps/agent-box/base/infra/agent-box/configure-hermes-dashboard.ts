#!/usr/bin/env node
/** Idempotent Hermes dashboard basic auth + mindi plugin enablement. */

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

const PLUGINS = ["mindi-desktop", "mindi-box", "mindi-join"] as const;

function homeDir(env: Env): string {
  return env.HOME ?? "/home/agent";
}

function hermesHome(env: Env): string {
  return env.HERMES_HOME ?? `${homeDir(env)}/.hermes`;
}

function profileName(env: Env): string {
  return env.PERSONA_NAME || env.HERMES_PROFILE || "default";
}

export function yamlDoubleQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function basicAuthBlock(user: string, password: string): string {
  return `dashboard:
  basic_auth:
    username: ${yamlDoubleQuote(user)}
    password: ${yamlDoubleQuote(password)}
`;
}

export function ensurePluginEnabled(text: string, name: string): string {
  const item = new RegExp(`^\\s*-\\s+${name}\\s*$`, "m");
  if (item.test(text)) {
    return text;
  }
  if (/^plugins:\s*$/m.test(text) && /enabled:/.test(text)) {
    return text.replace(/^( {2}enabled:\s*)$/m, `$1\n    - ${name}`);
  }
  if (/^plugins:\s*\n {2}enabled:\s*\n/m.test(text)) {
    return text.replace(
      /^(plugins:\s*\n {2}enabled:\s*\n)/m,
      `$1    - ${name}\n`,
    );
  }
  if (/^plugins:\s*$/m.test(text)) {
    return text.replace(
      /^plugins:\s*$/m,
      `plugins:\n  enabled:\n    - ${name}`,
    );
  }
  return `${text.replace(/\s+$/, "")}\nplugins:\n  enabled:\n    - ${name}\n`;
}

export function upsertBasicAuth(
  text: string,
  user: string,
  password: string,
): string {
  const userLine = `    username: ${yamlDoubleQuote(user)}`;
  const passLine = `    password: ${yamlDoubleQuote(password)}`;
  if (/basic_auth:/.test(text)) {
    let next = text;
    if (/username:/.test(next)) {
      next = next.replace(/^( {4}username:\s*).+$/m, userLine);
    } else {
      next = next.replace(/^( {2}basic_auth:\s*)$/m, `$1\n${userLine}`);
    }
    if (/password:/.test(next)) {
      next = next.replace(/^( {4}password:\s*).+$/m, passLine);
    } else {
      next = next.replace(/^( {4}username:\s*.+$)/m, `$1\n${passLine}`);
    }
    return next;
  }
  return `${text.replace(/\s+$/, "")}\n${basicAuthBlock(user, password)}`;
}

export function configureYaml(
  path: string,
  user: string,
  password: string,
): void {
  mkdirSync(dirname(path), { recursive: true });
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const withAuth = upsertBasicAuth(text, user, password);
  let next = withAuth;
  for (const name of PLUGINS) {
    next = ensurePluginEnabled(next, name);
  }
  writeFileSync(path, next);
}

export function configureHermesDashboard(env: Env = process.env): void {
  const password = env.DASHBOARD_PASSWORD ?? "";
  if (!password) {
    return;
  }
  const user = env.DASHBOARD_USER || "partner";
  const root = hermesHome(env);
  const profile = profileName(env);
  configureYaml(`${root}/config.yaml`, user, password);
  configureYaml(`${root}/profiles/${profile}/config.yaml`, user, password);
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
  configureHermesDashboard();
}
