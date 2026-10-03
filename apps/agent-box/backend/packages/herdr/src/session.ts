import { fileURLToPath } from "node:url";
import { fork, execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, lstat } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { TranscriptStore, transcriptId } from "./transcript.js";
const execute = promisify(execFile);
export interface TrustedLauncher {
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
}
export interface HerdrOptions {
  root: string;
  cwd: string;
  launcher?: TrustedLauncher;
  viewer: { command: string; args?: string[] };
  timeoutMs?: number;
}
export interface OwnedPane {
  paneId: string;
  terminalId: string;
  workspaceId: string;
  transcriptId: string;
}
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid Herdr response");
  return value as Record<string, unknown>;
}
/** Owns only presentation. It never starts Claude or sends ACP prompts/cancel. */
export class HerdrSession {
  readonly sessionName = "mindi-" + randomUUID().slice(0, 8);
  private child?: ChildProcess;
  private exited: Promise<void> = Promise.resolve();
  private alive = false;
  private guardianAlive = false;
  private serverFailed = false;
  private closing?: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private panes = new Map<string, OwnedPane>();
  private attempts = new Set<string>();
  private env: NodeJS.ProcessEnv = {};
  private directory = "";
  private constructor(private options: HerdrOptions) {}
  static async start(options: HerdrOptions): Promise<HerdrSession> {
    if (
      process.platform === "win32" ||
      !isAbsolute(options.root) ||
      !isAbsolute(options.cwd) ||
      !isAbsolute(options.viewer.command) ||
      options.viewer.args?.some((arg) => arg.includes("\0")) ||
      (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) ||
          options.timeoutMs < 100 ||
          options.timeoutMs > 30000))
    )
      throw Error("Invalid Herdr configuration");
    const session = new HerdrSession(options);
    try {
      await session.startOwned();
      return session;
    } catch (error) {
      await session.close().catch(() => {});
      throw error;
    }
  }
  isAlive() {
    return this.alive && !this.closing;
  }
  private async startOwned() {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    this.directory = await mkdtemp(join(this.options.root, "g-"));
    this.env = { ...(this.options.launcher?.env ?? process.env) };
    for (const key of Object.keys(this.env))
      if (key.startsWith("HERDR_")) delete this.env[key];
    this.env.XDG_CONFIG_HOME = join(this.directory, "config");
    this.env.XDG_STATE_HOME = join(this.directory, "state");
    this.env.HERDR_CONFIG_PATH = join(this.directory, "herdr.toml");
    await mkdir(this.env.XDG_CONFIG_HOME, { mode: 0o700 });
    await mkdir(this.env.XDG_STATE_HOME, { mode: 0o700 });
    await writeFile(
      this.env.HERDR_CONFIG_PATH,
      '[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[session]\nresume_agents_on_restore = false\n',
      { mode: 0o600 },
    );
    await this.receipt();
    const socket = join(
      this.env.XDG_CONFIG_HOME,
      "herdr",
      "sessions",
      this.sessionName,
      "herdr.sock",
    );
    if (Buffer.byteLength(socket) > 100)
      throw Error("Herdr requires a short private runtime root");
    const launch = this.options.launcher ?? { command: "herdr" };
    const source = import.meta.url.endsWith(".ts");
    const guardian = fileURLToPath(
      new URL(source ? "./guardian.ts" : "./guardian.js", import.meta.url),
    );
    this.child = fork(
      guardian,
      [
        launch.command,
        ...(launch.args ?? []),
        "--session",
        this.sessionName,
        "server",
      ],
      {
        cwd: this.options.cwd,
        env: this.env,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        detached: true,
        execArgv: source ? ["--experimental-strip-types"] : [],
      },
    );
    this.guardianAlive = true;
    this.child.on("message", (message) => {
      if (!message || typeof message !== "object" || !("type" in message))
        return;
      if (message.type === "server_started") this.alive = true;
      if (message.type === "server_exited") {
        this.alive = false;
        this.serverFailed = true;
      }
    });
    this.exited = new Promise((resolve) => {
      const exited = () => {
        this.alive = false;
        this.guardianAlive = false;
        this.serverFailed = true;
        resolve();
      };
      this.child!.once("exit", exited);
      this.child!.once("error", exited);
    });
    const deadline = Date.now() + (this.options.timeoutMs ?? 5000);
    while (Date.now() < deadline) {
      if (this.serverFailed) throw Error("Owned Herdr server exited");
      try {
        if (this.alive && (await lstat(socket)).isSocket()) return;
      } catch {
        // The owned server has not created its socket yet.
      }
      await delay(20);
    }
    throw Error("Owned Herdr server readiness timeout");
  }
  private async receipt() {
    await writeFile(
      join(this.directory, "ownership.json"),
      JSON.stringify({
        sessionName: this.sessionName,
        panes: [...this.panes.values()],
        attempts: [...this.attempts],
      }),
      { mode: 0o600 },
    );
  }
  private async command(args: string[]) {
    const launch = this.options.launcher ?? { command: "herdr" };
    const result = await execute(
      launch.command,
      [...(launch.args ?? []), "--session", this.sessionName, ...args],
      {
        cwd: this.options.cwd,
        env: this.env,
        timeout: this.options.timeoutMs ?? 5000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      },
    );
    return result.stdout.trim() ? object(JSON.parse(result.stdout)) : {};
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work);
    this.queue = pending.catch(() => {});
    return pending;
  }
  private assertAlive() {
    if (!this.isAlive()) throw Error("Owned Herdr server unavailable");
  }
  async openPane(store: TranscriptStore, id: string): Promise<OwnedPane> {
    return this.serial(async () => {
      this.assertAlive();
      transcriptId(id);
      await store.read(id);
      if (this.attempts.has(id))
        throw Error("Pane creation already attempted or uncertain");
      this.attempts.add(id);
      await this.receipt();
      const response = await this.command([
        "workspace",
        "create",
        "--cwd",
        this.options.cwd,
        "--label",
        "Claude " + id.slice(0, 8),
        "--no-focus",
      ]);
      const result = object(response.result),
        workspace = object(result.workspace),
        pane = object(result.root_pane);
      const workspaceId = workspace.workspace_id,
        paneId = pane.pane_id,
        terminalId = pane.terminal_id;
      if (
        typeof workspaceId !== "string" ||
        !/^w\d+$/.test(workspaceId) ||
        typeof paneId !== "string" ||
        !new RegExp("^" + workspaceId + ":p\\d+$").test(paneId) ||
        typeof terminalId !== "string" ||
        !terminalId
      )
        throw Error("Unknown pane ownership");
      const owned = { workspaceId, paneId, terminalId, transcriptId: id };
      this.panes.set(paneId, owned);
      await this.receipt();
      await this.checkPane(owned);
      const command = [
        this.options.viewer.command,
        ...(this.options.viewer.args ?? []),
        "--root",
        store.root,
        "--id",
        id,
        "--pane",
        paneId,
        "--session",
        this.sessionName,
      ]
        .map(quote)
        .join(" ");
      await this.command(["pane", "run", paneId, "exec " + command]);
      this.assertAlive();
      return { ...owned };
    });
  }
  private async checkPane(owned: OwnedPane) {
    const response = await this.command(["pane", "get", owned.paneId]);
    const pane = object(object(response.result).pane);
    if (pane.pane_id !== owned.paneId || pane.terminal_id !== owned.terminalId)
      throw Error("Pane ownership changed");
  }
  async closePane(paneId: string): Promise<void> {
    return this.serial(async () => {
      this.assertAlive();
      const owned = this.panes.get(paneId);
      if (!owned) throw Error("Pane is not owned");
      await this.checkPane(owned);
      await this.command(["pane", "close", paneId]);
      this.panes.delete(paneId);
      this.attempts.delete(owned.transcriptId);
      await this.receipt();
    });
  }
  close(): Promise<void> {
    this.closing ??= this.stopOwned();
    return this.closing;
  }
  private async stopOwned() {
    await this.queue;
    if (this.alive) {
      try {
        await this.command(["server", "stop"]);
      } catch {
        /* The retained guardian still owns group cleanup. */
      }
    }
    if (this.child) {
      if (!this.guardianAlive)
        throw Error("Owned Herdr guardian lost; descendant cleanup uncertain");
      await new Promise<void>((resolve, reject) =>
        this.child!.send({ type: "stop" }, (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          this.exited,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(Error("Owned Herdr cleanup unconfirmed")),
              1000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    this.alive = false;
  }
}
