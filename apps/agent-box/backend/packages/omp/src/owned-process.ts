import { fork, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { RuntimeError } from "@mindi/agent-runtime";

/** The parent holds an IPC capability; only the live guardian signals its group. */
export class OwnedOmpProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ownership = "guardian" as const;
  private started = false;
  private stopping = false;
  private exited = false;
  private settled = false;
  private closing?: Promise<void>;
  private readonly stopped: Promise<void>;
  private resolveStopped!: () => void;
  private rejectStopped!: (error: Error) => void;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private probeTimer?: ReturnType<typeof setTimeout>;
  get pid() {
    return this.child.pid;
  }

  constructor(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    onWorkerExit: () => void,
  ) {
    if (process.platform === "win32")
      throw new RuntimeError(
        "unavailable",
        "Local OMP workers require POSIX process ownership; connect to a Linux agent box",
      );
    this.stopped = new Promise((resolve, reject) => {
      this.resolveStopped = resolve;
      this.rejectStopped = reject;
    });
    void this.stopped.catch(() => {});
    const source = import.meta.url.endsWith(".ts");
    this.child = fork(
      fileURLToPath(
        new URL(source ? "./guardian.ts" : "./guardian.js", import.meta.url),
      ),
      [command, ...args],
      {
        cwd,
        env,
        detached: true,
        stdio: ["pipe", "pipe", "pipe", "ipc"],
        execArgv: source ? ["--experimental-strip-types"] : [],
      },
    ) as ChildProcessWithoutNullStreams;
    this.child.on("message", (message) => {
      if (!message || typeof message !== "object" || !("type" in message))
        return;
      // IPC may precede buffered stdout. Begin cleanup but preserve protocol
      // readers until the child "close" event confirms its streams drained.
      if (message.type === "worker_exited") void this.close();
      if (message.type === "stopping") this.stopping = true;
      if (message.type === "cleanup_failed") this.finish(false);
    });
    this.child.once("error", () => {
      this.finish(!this.child.pid);
      onWorkerExit();
    });
    this.child.once("close", (_code, signal) => {
      this.exited = true;
      clearTimeout(this.stopTimer);
      if (!this.started) this.finish(true);
      else if (this.stopping && signal === "SIGKILL") {
        this.deadline ??= setTimeout(() => this.finish(false), 1500);
        this.confirmAbsent();
      } else this.finish(false);
      onWorkerExit();
    });
  }
  private finish(confirmed: boolean) {
    if (this.settled) return;
    this.settled = true;
    clearTimeout(this.stopTimer);
    clearTimeout(this.deadline);
    clearTimeout(this.probeTimer);
    if (confirmed) this.resolveStopped();
    else
      this.rejectStopped(
        new RuntimeError(
          "cleanup_uncertain",
          "OMP cleanup could not be confirmed; verify the worker before retrying",
        ),
      );
  }
  private confirmAbsent() {
    if (this.settled) return;
    const pid = this.child.pid;
    if (!pid || !Number.isSafeInteger(pid) || pid <= 1)
      return this.finish(false);
    try {
      // Signal zero is a read-only presence probe, never a cleanup authority.
      process.kill(-pid, 0);
      this.probeTimer = setTimeout(() => this.confirmAbsent(), 20);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EPERM") {
        // A read-only probe may briefly be denied after guardian exit. Keep the
        // original deadline and require ESRCH; denial never confirms cleanup.
        this.probeTimer = setTimeout(() => this.confirmAbsent(), 20);
        return;
      }
      this.finish(
        error instanceof Error && "code" in error && error.code === "ESRCH",
      );
    }
  }
  async start(): Promise<void> {
    if (this.closing || this.exited || this.settled)
      throw new RuntimeError("cancelled", "OMP closed before start");
    if (this.started) return;
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      try {
        this.child.send!({ type: "start" }, (error: Error | null) =>
          error ? reject(error) : resolve(),
        );
      } catch (error) {
        reject(error);
      }
    });
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.stopped;
    if (this.exited || this.settled) return this.closing;
    this.deadline = setTimeout(() => this.finish(false), 1500);
    this.stopTimer = setTimeout(() => {
      try {
        this.child.send!({ type: "stop" }, (error: Error | null) => {
          if (error) this.finish(false);
        });
      } catch {
        this.finish(false);
      }
    }, 250);
    try {
      this.child.stdin.end();
    } catch {
      /* stop over the ownership channel */
    }
    return this.closing;
  }
}
