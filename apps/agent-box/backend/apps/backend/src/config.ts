import {
  parseGitHubPushConfig,
  type GitHubPushConfig,
} from "./github-pushes.js";
import {
  parseConnectorConfig,
  type ConnectorConfig,
} from "./connectors/config.js";
import {
  parseRoutineDeliveryConfig,
  type RoutineDeliveryConfig,
} from "./routine-delivery-config.js";
import { COORDINATOR_TOOLS } from "@mindi/coordinator";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import { isApprovalMode, type AgentProfile } from "@mindi/agent-runtime";
export interface BackendConfig {
  githubPush?: GitHubPushConfig;
  connectors?: ConnectorConfig;
  routineDeliveries?: RoutineDeliveryConfig[];
  voice?: { profileId: string };
  coordinator?: { profileId: string };
  herdr?: { command: string; runtimeRoot: string };
  claude?: { permissionKinds: string[]; interactivePermissions?: boolean };
  stateRoot: string;
  workspace: string;
  port: number;
  host?: "127.0.0.1" | "0.0.0.0";
  profiles: AgentProfile[];
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new Error("Invalid configuration fields");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error("Expected nonempty configuration string");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("Expected configuration list");
  return value.map(string);
}
async function readBounded(path: string) {
  if ((await stat(path)).size > 1024 * 1024)
    throw new Error("Configuration file exceeds limit");
  return readFile(path, "utf8");
}
export async function loadConfig(path: string): Promise<BackendConfig> {
  const base = dirname(resolve(path));
  const config = object(JSON.parse(await readBounded(path)) as unknown, [
    "stateRoot",
    "workspace",
    "port",
    "host",
    "profiles",
    "claude",
    "herdr",
    "routineDeliveries",
    "connectors",
    "voice",
    "coordinator",
    "githubPush",
  ]);
  if (
    !Array.isArray(config.profiles) ||
    config.profiles.length === 0 ||
    config.profiles.length > 32
  )
    throw new Error("Expected 1 to 32 profiles");
  const profiles: AgentProfile[] = [];
  for (const raw of config.profiles) {
    const item = object(raw, [
      "id",
      "instructionsFile",
      "modelIds",
      "defaultModelId",
      "tools",
      "approvalMode",
      "memory",
    ]);
    if (item.approvalMode !== undefined && !isApprovalMode(item.approvalMode))
      throw new Error("Invalid approval mode");
    const profile: AgentProfile = {
      id: string(item.id),
      approvalMode: item.approvalMode ?? "always-ask",
      instructions: await readBounded(
        resolve(base, string(item.instructionsFile)),
      ),
      modelIds: strings(item.modelIds),
      defaultModelId: string(item.defaultModelId),
      tools: item.tools === undefined ? [] : strings(item.tools),
    };
    if (item.memory !== undefined) {
      const memory = object(item.memory, ["url", "bankId"]);
      profile.memory = {
        url: string(memory.url),
        bankId: string(memory.bankId),
      };
    }
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/.test(profile.id) ||
      profiles.some((previous) => previous.id === profile.id)
    )
      throw new Error("Invalid or duplicate profile id");
    if (
      !profile.instructions.trim() ||
      !profile.modelIds.includes(profile.defaultModelId) ||
      profile.modelIds.some((model) => !/^[-a-zA-Z0-9_.]+\/[^\s]+$/.test(model))
    )
      throw new Error("Invalid persona model configuration");
    if (profile.tools?.some((tool) => !/^[-a-zA-Z0-9_]+$/.test(tool)))
      throw new Error("Invalid tool name");
    if (profile.memory) {
      const url = new URL(profile.memory.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(profile.memory.bankId)
      )
        throw new Error("Invalid memory configuration");
    }
    profiles.push(profile);
  }
  const host = config.host === undefined ? "127.0.0.1" : config.host;
  if (host !== "127.0.0.1" && host !== "0.0.0.0")
    throw new Error("Invalid backend bind address");
  const port = config.port ?? 65005;
  if (
    typeof port !== "number" ||
    !Number.isSafeInteger(port) ||
    port < 0 ||
    port > 65535
  )
    throw new Error("Invalid backend port");
  let claude: BackendConfig["claude"];
  if (config.claude !== undefined) {
    const policy = object(config.claude, [
      "permissionKinds",
      "interactivePermissions",
    ]);
    const permissionKinds = strings(policy.permissionKinds);
    if (
      permissionKinds.some(
        (kind) =>
          ![
            "read",
            "edit",
            "delete",
            "move",
            "search",
            "execute",
            "think",
            "fetch",
            "other",
          ].includes(kind),
      )
    )
      throw new Error("Invalid Claude permission kind");
    if (
      policy.interactivePermissions !== undefined &&
      typeof policy.interactivePermissions !== "boolean"
    )
      throw new Error("Invalid interactive permission policy");
    claude = {
      permissionKinds,
      ...(policy.interactivePermissions === undefined
        ? {}
        : { interactivePermissions: policy.interactivePermissions }),
    };
  }
  let herdr: BackendConfig["herdr"];
  if (config.herdr !== undefined) {
    const value = object(config.herdr, ["command", "runtimeRoot"]);
    const command = string(value.command),
      runtimeRoot = string(value.runtimeRoot);
    if (
      !isAbsolute(command) ||
      !isAbsolute(runtimeRoot) ||
      command.includes("\0") ||
      runtimeRoot.includes("\0")
    )
      throw Error("Herdr requires trusted absolute paths");
    herdr = { command, runtimeRoot };
  }
  let voice: BackendConfig["voice"];
  if (config.voice !== undefined) {
    const value = object(config.voice, ["profileId"]);
    const profileId =
      value.profileId === undefined ? "mindi" : string(value.profileId);
    if (!profiles.some((profile) => profile.id === profileId))
      throw new Error("Unknown voice coordinator profile");
    voice = { profileId };
  }
  let coordinator: BackendConfig["coordinator"];
  if (config.coordinator !== undefined) {
    const value = object(config.coordinator, ["profileId"]);
    coordinator = {
      profileId:
        value.profileId === undefined ? "mindi" : string(value.profileId),
    };
  }
  validateCoordinator({ coordinator, voice, profiles });
  return {
    ...(config.githubPush === undefined
      ? {}
      : { githubPush: parseGitHubPushConfig(config.githubPush, base) }),
    ...(config.connectors === undefined
      ? {}
      : {
          connectors: parseConnectorConfig(
            config.connectors,
            base,
            profiles.map((profile) => profile.id),
          ),
        }),
    ...(config.routineDeliveries === undefined
      ? {}
      : {
          routineDeliveries: parseRoutineDeliveryConfig(
            config.routineDeliveries,
            base,
          ),
        }),
    ...(voice ? { voice } : {}),
    ...(coordinator ? { coordinator } : {}),
    ...(claude ? { claude } : {}),
    ...(herdr ? { herdr } : {}),
    stateRoot: resolve(base, string(config.stateRoot)),
    workspace: resolve(base, string(config.workspace)),
    port,
    host,
    profiles,
  };
}

/** Also validate callers that construct configuration without loadConfig. */
export function validateCoordinator(
  config: Pick<BackendConfig, "coordinator" | "voice" | "profiles">,
): void {
  if (!config.coordinator) return;
  const profile = config.profiles.find(
    (p) => p.id === config.coordinator!.profileId,
  );
  if (!profile) throw new Error("Unknown coordinator profile");
  if (
    profile.tools?.some(
      (tool) => !(COORDINATOR_TOOLS as readonly string[]).includes(tool),
    )
  )
    throw new Error("Pi coordinator permits coordination tools only");
  if (config.voice && config.voice.profileId !== profile.id)
    throw new Error("Voice must use the configured main coordinator");
}
