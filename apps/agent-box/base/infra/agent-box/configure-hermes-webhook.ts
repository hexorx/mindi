#!/usr/bin/env node
/** Idempotent Hermes webhook-platform wiring. Comments post as the service account. */

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

export function webhookYaml(secret: string): string {
  const promptReview = `              A pull request event was received (action: {action}).
              PR #{number}: {pull_request.title}
              Author: {pull_request.user.login}
              Branch: {pull_request.head.ref} → {pull_request.base.ref}
              URL: {pull_request.html_url}
              If the action is "closed" or "labeled", stop here and do not post a comment.
              Otherwise:
              1. Run: gh pr diff {number} --repo {repository.full_name}
              2. Review the diff for correctness, security, and missing tests.
              3. Write a concise, actionable review. Delivery posts it as the GitHub service account.
`;
  const promptPm = `              A GitHub event was received ({action}) for {repository.full_name}.
              Subject: {issue.title}{pull_request.title}
              URL: {issue.html_url}{pull_request.html_url}
              If the action is "closed", "labeled", or "assigned", stop here and do not post a comment.
              Otherwise triage the issue or PR and write a concise comment.
              Delivery posts it as the GitHub service account.
`;
  const secretLine = secret
    ? `            secret: "${secret}"`
    : '            secret: "INSECURE_NO_AUTH"';
  return `
gateway:
  platforms:
    webhook:
      enabled: true
      extra:
        host: 127.0.0.1
        port: 8644
        routes:
          github-pr-review:
${secretLine}
            events:
              - pull_request
            filters:
              - field: "action"
                in: ["opened", "synchronize", "reopened"]
            toolsets: ["terminal", "web"]
            deliver: github_comment
            deliver_extra:
              repo: "{repository.full_name}"
              pr_number: "{number}"
            prompt: |
${promptReview}
          github-pm:
${secretLine}
            events:
              - issues
              - issue_comment
              - pull_request
            toolsets: ["terminal", "web"]
            deliver: github_comment
            deliver_extra:
              repo: "{repository.full_name}"
              issue_number: "{issue.number}"
            prompt: |
${promptPm}
`;
}

export function stripGatewayWebhook(text: string): string {
  const lines = text.split(/\n/);
  const out: string[] = [];
  let inGateway = false;
  let inPlatforms = false;
  let skipping = false;
  for (const line of lines) {
    if (skipping) {
      if (
        line.startsWith("    ") &&
        !line.startsWith("     ") &&
        line.trim().endsWith(":")
      ) {
        skipping = false;
      } else if (line && !line.startsWith(" ") && !line.startsWith("\t")) {
        skipping = false;
      } else {
        continue;
      }
    }
    if (line.startsWith("gateway:")) {
      inGateway = true;
      inPlatforms = false;
      out.push(line);
      continue;
    }
    if (inGateway && line.startsWith("  platforms:")) {
      inPlatforms = true;
      out.push(line);
      continue;
    }
    if (inGateway && line && !line.startsWith(" ") && !line.startsWith("\t")) {
      inGateway = false;
      inPlatforms = false;
    }
    if (inPlatforms && line.startsWith("    webhook:")) {
      skipping = true;
      continue;
    }
    out.push(line);
  }
  return `${out.join("\n").replace(/\s+$/, "")}${out.length ? "\n" : ""}`;
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

export function ensureWebhookYaml(path: string, secret: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let text = existsSync(path) ? readFileSync(path, "utf8") : "";
  const hasExpectedSecret =
    Boolean(secret) && text.includes(`secret: "${secret}"`);
  const fresh =
    text.includes("github-pr-review") &&
    text.includes("github_comment") &&
    text.includes("host: 127.0.0.1") &&
    !text.includes("COMMAND_URL") &&
    !text.includes("deliver: log") &&
    (!secret || hasExpectedSecret);
  if (fresh) {
    return;
  }
  if (text.includes("github-pr-review") || text.includes("    webhook:")) {
    text = stripGatewayWebhook(text);
  }
  const prefix = text.replace(/\s+$/, "");
  const addition = webhookYaml(secret).replace(/^\s+/, "");
  writeFileSync(path, prefix ? `${prefix}\n${addition}` : addition);
}

export function configureHermesWebhook(env: Env = process.env): void {
  const secret = env.HERMES_WEBHOOK_SECRET ?? "";
  const root = hermesHome(env);
  const profile = profileName(env);
  if (secret) {
    const updates = { HERMES_WEBHOOK_SECRET: secret };
    upsertEnv(`${root}/.env`, updates);
    upsertEnv(`${root}/profiles/${profile}/.env`, updates);
  }
  ensureWebhookYaml(`${root}/config.yaml`, secret);
  ensureWebhookYaml(`${root}/profiles/${profile}/config.yaml`, secret);
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
  configureHermesWebhook();
}
