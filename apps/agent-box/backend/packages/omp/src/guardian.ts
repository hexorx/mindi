import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface GuardianHost {
  pid: number;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  on(
    event: "message" | "disconnect" | "SIGTERM" | "SIGINT",
    callback: (message?: unknown) => void,
  ): unknown;
  send?: (
    message: { type: string },
    callback: (error: Error | null) => void,
  ) => boolean;
  kill(pid: number, signal: "SIGKILL"): boolean;
}
type Launch = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

/** Only this retained live group leader may signal its own group. */
export function supervise(
  host: GuardianHost,
  command: string,
  args: string[],
  launch: Launch = spawn,
): void {
  if (
    host.platform === "win32" ||
    !host.send ||
    !Number.isSafeInteger(host.pid) ||
    host.pid <= 1 ||
    !command
  )
    throw Error("Invalid OMP guardian launch");
  let started = false;
  let closing = false;
  let stopInFlight = false;
  const killOwnedGroup = () => {
    try {
      if (!host.kill(-host.pid, "SIGKILL"))
        throw Error("Unconfirmed group signal");
    } catch {
      stopInFlight = false;
      // Do not convert denial into success or let a timer/event callback throw.
      // Keep the guardian available; the parent must record unknown cleanup.
      try {
        host.send?.({ type: "cleanup_failed" }, () => {});
      } catch {
        /* disconnected parent */
      }
    }
  };
  const stop = () => {
    closing = true;
    if (stopInFlight) return;
    stopInFlight = true;
    try {
      // Flush intent before the self-terminating signal. This is not a receipt
      // of completed cleanup; the parent must also observe the owner's exit.
      host.send!({ type: "stopping" }, () => killOwnedGroup());
    } catch {
      killOwnedGroup();
    }
  };
  const reportExit = () => {
    try {
      host.send!({ type: "worker_exited" }, (error) => {
        if (error) stop();
      });
    } catch {
      stop();
    }
  };
  host.on("disconnect", stop);
  host.on("SIGTERM", stop);
  host.on("SIGINT", stop);
  host.on("message", (message) => {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    if (message.type === "stop") {
      stop();
      return;
    }
    if (message.type !== "start" || started || closing) return;
    started = true;
    try {
      const worker = launch(command, args, {
        env: host.env,
        stdio: ["inherit", "inherit", "inherit"],
        detached: false,
      });
      worker.once("exit", reportExit);
      worker.once("error", reportExit);
    } catch {
      reportExit();
    }
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, ...args] = process.argv.slice(2);
  try {
    supervise(process, command ?? "", args);
  } catch {
    process.exitCode = 2;
  }
}
