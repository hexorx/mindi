import { spawn } from "node:child_process";
// This live group leader alone signals its group. No remembered PID is a cleanup authority.
const stop = () => {
  process.kill(-process.pid, "SIGKILL");
};
process.on("disconnect", stop);
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", (message) => {
  if (
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "stop"
  )
    stop();
});
const [command, ...args] = process.argv.slice(2);
if (!command || !process.send || process.platform === "win32") process.exit(2);
const server = spawn(command, args, { stdio: "ignore", env: process.env });
const report = (type: string) =>
  process.send?.({ type }, (error) => {
    if (error) stop();
  });
server.once("spawn", () => report("server_started"));
server.once("exit", () => report("server_exited"));
server.once("error", () => report("server_exited"));
