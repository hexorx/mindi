import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID, createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const execute = promisify(execFile);

export interface DesktopSession {
  environment: Record<string, string>;
  vncSocket: string;
  isAlive(): boolean;
  stop(): Promise<void>;
}
export interface DesktopStatus {
  profileId: string;
  generation: string;
  state: "disabled" | "starting" | "ready" | "failed" | "unavailable";
  error?: string;
}
export interface DesktopRequest {
  profileId: string;
  enabled: boolean;
  error?: string;
}
export interface DesktopLaunch {
  profileId: string;
  profileHome: string;
  runtimeDir: string;
  generation: string;
}
export interface ManagerOptions {
  profilesRoot: string;
  runtimeRoot: string;
  retryMs?: number;
  launch(request: DesktopLaunch): Promise<DesktopSession>;
}
interface Entry {
  status: DesktopStatus;
  profileHome: string;
  runtimeDir?: string;
  session?: DesktopSession;
  retryAt: number;
}
/** Owns only the sessions it launches. Callers serialize process ownership with flock. */
export class ProfileDesktopManager {
  private entries = new Map<string, Entry>();
  private pending: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(private readonly options: ManagerOptions) {
    if (!isAbsolute(options.profilesRoot) || !isAbsolute(options.runtimeRoot))
      throw new Error("Desktop roots must be absolute");
  }
  private queue(work: () => Promise<void>): Promise<void> {
    const result = this.pending.then(work);
    this.pending = result.catch(() => {});
    return result;
  }
  private async publish(entry: Entry): Promise<void> {
    const record = {
      version: 1,
      ...entry.status,
      profileHome: entry.profileHome,
      ...(entry.status.state === "ready" && entry.session
        ? {
            environment: entry.session.environment,
            vncSocket: entry.session.vncSocket,
          }
        : {}),
    };
    const target = join(entry.profileHome, ".mindi-desktop.json");
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  private async release(
    entry: Entry,
    state: DesktopStatus["state"],
  ): Promise<void> {
    entry.status = {
      ...entry.status,
      state: entry.session ? "unavailable" : state,
    };
    delete entry.status.error;
    // Withdraw readiness first, but a deleted/unwritable profile must never prevent teardown.
    const failures: unknown[] = [];
    try {
      await this.publish(entry);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        failures.push(error);
    }
    try {
      await entry.session?.stop();
      entry.session = undefined;
    } catch (error) {
      failures.push(error);
    }
    if (!entry.session && entry.runtimeDir) {
      try {
        await rm(entry.runtimeDir, { recursive: true, force: true });
        entry.runtimeDir = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Desktop teardown encountered errors");
    if (entry.status.state !== state) {
      entry.status = { ...entry.status, state };
      try {
        await this.publish(entry);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  reconcile(desired: DesktopRequest[]): Promise<void> {
    return this.queue(async () => {
      if (this.stopped) throw new Error("Desktop manager stopped");
      const profilesRoot = await realpath(this.options.profilesRoot);
      const runtimeRoot = await realpath(this.options.runtimeRoot);
      const info = await lstat(runtimeRoot);
      if (
        !info.isDirectory() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o077) !== 0
      )
        throw new Error(
          "Desktop runtime directory must be private and owned by this user",
        );
      const validated = new Map<
        string,
        { enabled: boolean; home: string; error?: string }
      >();
      // Validate the complete request before changing any running profile.
      for (const request of desired) {
        if (
          !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(request.profileId) ||
          typeof request.enabled !== "boolean" ||
          validated.has(request.profileId)
        )
          throw new Error("Invalid or duplicate desktop profile");
        const home = join(profilesRoot, request.profileId);
        if (
          (await realpath(home)) !== resolve(home) ||
          !(await lstat(home)).isDirectory()
        )
          throw new Error("Desktop profile must be a canonical directory");
        validated.set(request.profileId, {
          enabled: request.enabled,
          home,
          error: request.error,
        });
      }
      const failures: unknown[] = [];
      for (const [id, entry] of this.entries) {
        if (!validated.has(id)) {
          try {
            await this.release(entry, "unavailable");
            this.entries.delete(id);
          } catch (error) {
            failures.push(error);
          }
        }
      }
      for (const [profileId, { enabled, home, error }] of validated) {
        try {
          let entry = this.entries.get(profileId);
          if (!entry) {
            entry = {
              profileHome: home,
              retryAt: 0,
              status: {
                profileId,
                generation: randomUUID(),
                state: "disabled",
              },
            };
            this.entries.set(profileId, entry);
          }
          if (!enabled) {
            await this.release(entry, error ? "failed" : "disabled");
            if (error) {
              entry.status.error = error;
              await this.publish(entry);
            }
            continue;
          }
          if (entry.session?.isAlive()) continue;
          if (entry.session) await this.release(entry, "failed");
          if (entry.retryAt > Date.now()) continue;
          const generation = randomUUID();
          entry.status = { profileId, generation, state: "starting" };
          const prefix = createHash("sha256")
            .update(profileId)
            .digest("hex")
            .slice(0, 12);
          entry.runtimeDir = join(
            runtimeRoot,
            `${prefix}-${generation.slice(0, 8)}`,
          );
          try {
            await mkdir(entry.runtimeDir, { mode: 0o700 });
            await writeFile(
              join(entry.runtimeDir, ".desktop-owner.json"),
              JSON.stringify({ version: 1, profileId, generation }),
              { flag: "wx", mode: 0o600 },
            );
            await this.publish(entry);
            entry.session = await this.options.launch({
              profileId,
              profileHome: home,
              runtimeDir: entry.runtimeDir,
              generation,
            });
            if (!entry.session.isAlive())
              throw new Error("Desktop exited before ready");
            entry.status.state = "ready";
            await this.publish(entry);
          } catch {
            await this.release(entry, "failed");
            entry.status.error = "Desktop could not start; retrying";
            entry.retryAt = Date.now() + (this.options.retryMs ?? 5000);
            await this.publish(entry);
          }
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "Desktop reconciliation encountered errors",
        );
    });
  }
  status(): DesktopStatus[] {
    return [...this.entries.values()].map((entry) => ({ ...entry.status }));
  }
  stop(): Promise<void> {
    return this.queue(async () => {
      this.stopped = true;
      const results = await Promise.allSettled(
        [...this.entries.values()].map((entry) =>
          this.release(entry, "unavailable"),
        ),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Desktop shutdown encountered errors",
        );
    });
  }
}

/** Linux-only process adapter. Every process is a direct child with a parent-death signal. */
export async function launchWaylandDesktop(
  request: DesktopLaunch,
  options: { width?: number; height?: number; browser?: boolean } = {},
): Promise<DesktopSession> {
  const width = options.width ?? 1920,
    height = options.height ?? 1080;
  if (
    ![width, height].every((n) => Number.isInteger(n) && n >= 320 && n <= 4096)
  )
    throw new Error("Invalid desktop dimensions");
  const { runtimeDir, profileHome } = request;
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "SWAYSOCK",
    "DBUS_SESSION_BUS_ADDRESS",
  ])
    delete environment[key];
  Object.assign(environment, {
    XDG_RUNTIME_DIR: runtimeDir,
    XDG_SESSION_TYPE: "wayland",
    WLR_BACKENDS: "headless",
    WLR_HEADLESS_OUTPUTS: "1",
    WLR_RENDERER: "pixman",
    WLR_LIBINPUT_NO_DEVICES: "1",
    CUA_DRIVER_RS_ENABLE_WAYLAND: "1",
    MINDI_CHROME_USER_DATA_DIR: join(profileHome, ".config", "google-chrome"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(runtimeDir, "bus")}`,
  });
  const processes: Array<{ alive: () => boolean; stop: () => Promise<void> }> =
    [];
  const log = await open(join(runtimeDir, "desktop.log"), "a", 0o600);
  const launch = (command: string, args: string[]) => {
    const child = spawn(
      "setpriv",
      [
        "--pdeathsig",
        "TERM",
        "sh",
        "-c",
        '[ "$PPID" = "$1" ] || exit 1; shift; exec "$@"',
        "mindi-desktop-child",
        String(process.pid),
        command,
        ...args,
      ],
      {
        env: environment,
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    let running = true;
    const exited = new Promise<void>((resolve) => {
      child.once("error", () => {
        running = false;
        resolve();
      });
      child.once("exit", () => {
        running = false;
        resolve();
      });
    });
    const signal = (name: NodeJS.Signals) => {
      if (!running || !child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const processHandle = {
      pid: child.pid,
      alive: () => running,
      stop: async () => {
        signal("SIGTERM");
        await Promise.race([exited, delay(2000, undefined, { ref: false })]);
        if (running) {
          signal("SIGKILL");
          await exited;
        }
      },
    };
    processes.push(processHandle);
    return processHandle;
  };
  const stop = async () => {
    for (const child of [...processes].reverse()) await child.stop();
    await log.close();
  };
  const waitFor = async (check: () => Promise<boolean>, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (processes.some((child) => !child.alive()))
        throw new Error("Desktop child exited during startup");
      if (await check()) return;
      await delay(50);
    }
    throw new Error("Desktop startup timeout");
  };
  const socketExists = async (path: string) => {
    try {
      return (await lstat(path)).isSocket();
    } catch {
      return false;
    }
  };
  try {
    launch("dbus-daemon", [
      "--session",
      `--address=${environment.DBUS_SESSION_BUS_ADDRESS}`,
      "--nofork",
      "--nopidfile",
    ]);
    await waitFor(() => socketExists(join(runtimeDir, "bus")));
    const config = join(runtimeDir, "sway.conf");
    await writeFile(
      config,
      `xwayland disable\noutput HEADLESS-1 mode ${width}x${height} pos 0 0\ndefault_border none\ngaps inner 0\ngaps outer 0\n`,
      { mode: 0o600 },
    );
    launch("sway", ["--config", config]);
    await waitFor(async () => {
      const names = await readdir(runtimeDir);
      const wayland = names.find((name) => /^wayland-\d+$/.test(name));
      const sway = names.find((name) => /^sway-ipc\..*\.sock$/.test(name));
      if (
        !wayland ||
        !sway ||
        !(await socketExists(join(runtimeDir, wayland))) ||
        !(await socketExists(join(runtimeDir, sway)))
      )
        return false;
      environment.WAYLAND_DISPLAY = wayland;
      environment.SWAYSOCK = join(runtimeDir, sway);
      return true;
    });
    // Keep wl_keyboard/wl_pointer available between Cua's short-lived devices.
    // The helper emits no input and shares this generation's health and cleanup.
    launch("/usr/local/bin/mindi-input-seat", []);
    await waitFor(async () => {
      const { stdout } = await execute("swaymsg", ["-t", "get_seats", "-r"], {
        env: environment,
        timeout: 2000,
        maxBuffer: 1024 * 1024,
      });
      return (
        JSON.parse(stdout) as Array<{ name: string; capabilities: number }>
      ).some((seat) => seat.name === "seat0" && (seat.capabilities & 3) === 3);
    });
    const vncSocket = join(runtimeDir, "vnc.sock");
    // Owned viewers must not inherit ~/.config/wayvnc (shared :5900 auth).
    const wayvncConfig = join(runtimeDir, "wayvnc.conf");
    await writeFile(wayvncConfig, "enable_auth=false\n", { mode: 0o600 });
    launch("wayvnc", [
      "--config",
      wayvncConfig,
      "--disable-input",
      "--disable-resizing",
      "--unix-socket",
      "--socket",
      join(runtimeDir, "vnc-control.sock"),
      vncSocket,
    ]);
    await waitFor(() => socketExists(vncSocket));
    await new Promise<void>((resolve, reject) => {
      const client = connect(vncSocket);
      let bytes = "";
      client.setTimeout(2000);
      client.on("data", (data) => {
        bytes += data.toString();
        if (bytes.length >= 12) {
          client.destroy();
          if (/^RFB \d{3}\.\d{3}\n/.test(bytes)) resolve();
          else reject(new Error("Invalid VNC handshake"));
        }
      });
      client.once("error", reject);
      client.once("timeout", () => {
        client.destroy();
        reject(new Error("VNC readiness timeout"));
      });
      client.once("end", () => {
        if (bytes.length < 12) reject(new Error("VNC closed before ready"));
      });
    });
    if (options.browser !== false) {
      const browserPath = environment.MINDI_CHROME_USER_DATA_DIR!;
      for (const directory of [join(profileHome, ".config"), browserPath]) {
        try {
          await mkdir(directory, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        const info = await lstat(directory);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          (info.mode & 0o077) !== 0 ||
          info.uid !== process.getuid?.() ||
          (await realpath(directory)) !== resolve(directory)
        )
          throw new Error(
            "Browser profile must be a private owned canonical directory",
          );
      }
      const browser = launch("/usr/bin/google-chrome-stable", [
        "--ozone-platform=wayland",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-mode",
        "--disable-gpu",
        "--force-renderer-accessibility",
        `--user-data-dir=${browserPath}`,
        "about:blank",
      ]);
      const terminateBrowser = browser.stop;
      browser.stop = async () => {
        if (browser.alive()) {
          // A window close lets Chrome flush profile storage before group teardown.
          await execute("swaymsg", [`[pid=${browser.pid}]`, "kill"], {
            env: environment,
            timeout: 2000,
          }).catch(() => undefined);
          const deadline = Date.now() + 5000;
          while (browser.alive() && Date.now() < deadline) await delay(50);
        }
        await terminateBrowser();
      };
      await waitFor(async () => {
        const { stdout } = await execute("swaymsg", ["-t", "get_tree", "-r"], {
          env: environment,
          timeout: 2000,
          maxBuffer: 1048576,
        });
        const visible = (node: {
          pid?: number;
          app_id?: string;
          nodes?: unknown[];
          floating_nodes?: unknown[];
        }): boolean =>
          (node.pid === browser.pid && !!node.app_id) ||
          [...(node.nodes ?? []), ...(node.floating_nodes ?? [])].some(
            (child) => visible(child as typeof node),
          );
        return visible(JSON.parse(stdout));
      }, 30_000);
    }
    const keys = [
      "XDG_RUNTIME_DIR",
      "XDG_SESSION_TYPE",
      "WAYLAND_DISPLAY",
      "SWAYSOCK",
      "DBUS_SESSION_BUS_ADDRESS",
      "CUA_DRIVER_RS_ENABLE_WAYLAND",
      "MINDI_CHROME_USER_DATA_DIR",
    ];
    return {
      environment: Object.fromEntries(
        keys.map((key) => [key, environment[key]!]),
      ),
      vncSocket,
      isAlive: () => processes.every((child) => child.alive()),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
