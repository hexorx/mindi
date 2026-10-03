import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Models } from "@earendil-works/pi-ai";
import { CoordinatorCredentialStore } from "./auth.js";

export async function coordinatorAuthCommand(
  action: string,
  models: Pick<Models, "login" | "logout" | "checkAuth">,
  write: (text: string) => void,
  signal: AbortSignal,
) {
  const provider = "openai-codex";
  if (action === "status") {
    const auth = await models.checkAuth(provider, { signal });
    write(
      auth?.type === "oauth"
        ? "OpenAI subscription login is stored; provider access is not verified.\n"
        : "OpenAI subscription is not logged in.\n",
    );
  } else if (action === "logout") {
    await models.logout(provider, { signal });
    write("Coordinator OpenAI subscription logged out.\n");
  } else if (action === "login") {
    await models.login(provider, "oauth", {
      signal,
      prompt: async (prompt) => {
        if (
          prompt.type === "select" &&
          prompt.options.some((o) => o.id === "device_code")
        )
          return "device_code";
        throw new Error("Unexpected subscription login prompt");
      },
      notify: (event) => {
        if (event.type === "device_code")
          write(
            `Open ${event.verificationUri} and enter code ${event.userCode}\n`,
          );
        else if (event.type === "auth_url") write(`Open ${event.url}\n`);
      },
    });
    write("Coordinator OpenAI subscription login saved.\n");
  } else throw new Error("Unknown coordinator authentication command");
}

async function main() {
  const [root, action] = process.argv.slice(2);
  if (!root || !["login", "status", "logout"].includes(action ?? "")) {
    process.stderr.write(
      "Usage: node login.js /absolute/backend/stateRoot login|status|logout\n",
    );
    process.exitCode = 1;
    return;
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timeout = setTimeout(interrupt, 16 * 60 * 1000);
  timeout.unref();
  try {
    const models = builtinModels({
      credentials: new CoordinatorCredentialStore(root),
    });
    await coordinatorAuthCommand(
      action!,
      models,
      (text) => process.stdout.write(text),
      controller.signal,
    );
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  void main().catch(() => {
    process.stderr.write(
      "Coordinator subscription authentication failed. Check device-login access, connectivity and state-directory permissions, then retry. For corrupt stored credentials, run logout then login.\n",
    );
    process.exitCode = 1;
  });
}
