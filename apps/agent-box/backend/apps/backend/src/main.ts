import { loadConfig } from "./config.js";
import { startApplication } from "./application.js";
async function main() {
  const path = process.argv[2];
  const token = process.env.MINDI_BACKEND_TOKEN;
  if (!path || !token)
    throw new Error("Provide configuration path and MINDI_BACKEND_TOKEN");
  const app = await startApplication({
    config: await loadConfig(path),
    token,
    openAiApiKey: process.env.OPENAI_API_KEY,
  });
  process.stdout.write(`Mindi backend listening at ${app.url}\n`);
  const close = () => {
    void app.close().catch(() => {
      process.stderr.write("Backend shutdown failed\n");
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
void main().catch(() => {
  process.stderr.write(
    "Backend startup failed; check configuration, runtime versions and local state access\n",
  );
  process.exitCode = 1;
});
