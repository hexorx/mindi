import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  DesktopError,
  DesktopSettings,
  type DesktopSetting,
} from "./settings.js";
import { acquireDesktopOwnership, recoverDesktopRuntime } from "./ownership.js";
import {
  ProfileDesktopManager,
  launchWaylandDesktop,
  type DesktopLaunch,
  type DesktopSession,
  type DesktopStatus,
} from "./profiles.js";
import { DesktopInputBroker } from "./control/broker.js";
import { launchDesktopDriver } from "./control/driver.js";
export interface DesktopConnection {
  broker: DesktopInputBroker;
  isAlive(): boolean;
  close(): Promise<void>;
}
export interface DesktopServiceOptions {
  stateRoot: string;
  listProfiles(): Array<{ id: string }>;
  validateProfile(id: string): void;
  launch?(request: DesktopLaunch): Promise<DesktopSession>;
  connect?(
    request: DesktopLaunch,
    session: DesktopSession,
  ): Promise<DesktopConnection>;
}
export interface DesktopView {
  settings: DesktopSetting;
  desktop: { state: DesktopStatus["state"]; generation?: string };
  fault?: { code: "unavailable"; message: string };
}
interface Owned {
  generation: string;
  session: DesktopSession;
  connection?: DesktopConnection;
  epoch: number;
}
async function connectDriver(
  _request: DesktopLaunch,
  session: DesktopSession,
): Promise<DesktopConnection> {
  const env = { ...process.env };
  for (const key of [
    "DISPLAY",
    "WAYLAND_DISPLAY",
    "SWAYSOCK",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "HERMES_HOME",
  ])
    delete env[key];
  Object.assign(env, session.environment);
  const driver = launchDesktopDriver("cua-driver", ["mcp"], env);
  try {
    await driver.initialize();
  } catch (error) {
    driver.disconnect();
    await driver.waitForExit();
    throw error;
  }
  let closed = false;
  return {
    broker: new DesktopInputBroker(driver),
    isAlive: () => !closed && driver.isReady(),
    close: async () => {
      closed = true;
      driver.disconnect();
      await driver.waitForExit();
    },
  };
}
/** Application-owned service. access() is trusted internal routing, never an HTTP response. */
export class DesktopService {
  private manager: ProfileDesktopManager;
  private owned = new Map<string, Owned>();
  private epochs = new Map<string, number>();
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  private requested = 0;
  private shutdown?: Promise<void>;
  private fault?: DesktopView["fault"];
  constructor(
    private options: DesktopServiceOptions,
    private settings: DesktopSettings,
    private release: () => void,
    private profilesRoot: string,
    runtimeRoot: string,
  ) {
    this.manager = new ProfileDesktopManager({
      profilesRoot,
      runtimeRoot,
      launch: async (request) => {
        const epoch = this.epochs.get(request.profileId) ?? 0;
        const session = await (options.launch ?? launchWaylandDesktop)(request);
        let connection: DesktopConnection | undefined;
        try {
          connection = await (options.connect ?? connectDriver)(
            request,
            session,
          );
        } catch {
          // Return an unready owned session so the manager retains teardown
          // responsibility, including when the first stop attempt fails.
        }
        const owned = {
          generation: request.generation,
          session,
          connection,
          epoch,
        };
        this.owned.set(request.profileId, owned);
        return {
          ...session,
          isAlive: () =>
            epoch === (this.epochs.get(request.profileId) ?? 0) &&
            session.isAlive() &&
            !!connection?.isAlive(),
          stop: async () => {
            const failures: unknown[] = [];
            try {
              await connection?.close();
            } catch (error) {
              failures.push(error);
            }
            try {
              await session.stop();
            } catch (error) {
              failures.push(error);
            }
            if (failures.length)
              throw new AggregateError(
                failures,
                "Desktop generation teardown failed",
              );
            if (this.owned.get(request.profileId) === owned)
              this.owned.delete(request.profileId);
          },
        };
      },
    });
  }
  get(profileId: string): DesktopView {
    if (this.closed) throw new DesktopError("closed");
    const settings = this.settings.get(profileId);
    const status = this.manager
      .status()
      .find((item) => item.profileId === profileId);
    const owned = this.owned.get(profileId);
    let state: DesktopStatus["state"] =
      status?.state ?? (settings.enabled ? "starting" : "disabled");
    if (!settings.enabled && state !== "disabled")
      state = owned ? "unavailable" : "disabled";
    if (settings.enabled && state === "disabled") state = "starting";
    if (
      state === "ready" &&
      (!owned?.session.isAlive() ||
        !owned.connection?.isAlive() ||
        owned.epoch !== (this.epochs.get(profileId) ?? 0))
    )
      state = "unavailable";
    return {
      settings,
      desktop: { state, ...(status ? { generation: status.generation } : {}) },
      ...(this.fault ? { fault: { ...this.fault } } : {}),
    };
  }
  update(
    profileId: string,
    input: { expectedRevision: number; enabled: boolean },
  ): DesktopView {
    if (this.closed) throw new DesktopError("closed");
    this.settings.update(profileId, input);
    if (!input.enabled)
      this.epochs.set(profileId, (this.epochs.get(profileId) ?? 0) + 1);
    this.requested++;
    void this.tick();
    return this.get(profileId);
  }
  access(profileId: string, generation: string) {
    const view = this.get(profileId);
    const owned = this.owned.get(profileId);
    if (
      this.fault ||
      !view.settings.enabled ||
      view.desktop.state !== "ready" ||
      !owned ||
      !owned.connection ||
      owned.generation !== generation ||
      view.desktop.generation !== generation
    )
      throw new DesktopError("conflict");
    return {
      broker: owned.connection.broker,
      environment: { ...owned.session.environment },
      vncSocket: owned.session.vncSocket,
      generation,
    };
  }
  start(): void {
    if (this.closed || this.timer || this.fault) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 1000);
    this.timer.unref();
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.active) return this.active;
    if (this.closed || this.fault) return Promise.resolve();
    this.active = Promise.resolve()
      .then(async () => {
        do {
          const requested = this.requested;
          const desired = this.options
            .listProfiles()
            .map((profile) => this.settings.get(profile.id));
          for (const profile of desired)
            await mkdir(join(this.profilesRoot, profile.profileId), {
              recursive: true,
              mode: 0o700,
            });
          await this.manager.reconcile(desired);
          if (requested === this.requested) break;
        } while (!this.closed);
      })
      .catch(() => {
        this.fault = {
          code: "unavailable",
          message: "Desktop reconciliation requires operator attention",
        };
        clearInterval(this.timer);
        this.timer = undefined;
      })
      .finally(() => {
        this.active = undefined;
      });
    return this.active;
  }
  close(): Promise<void> {
    if (this.shutdown) return this.shutdown;
    this.closed = true;
    clearInterval(this.timer);
    this.timer = undefined;
    this.shutdown = (async () => {
      try {
        await this.active;
        await this.manager.stop();
      } finally {
        try {
          this.settings.close();
        } finally {
          this.release();
        }
      }
    })();
    return this.shutdown;
  }
}
export async function startDesktopService(
  options: DesktopServiceOptions,
): Promise<DesktopService> {
  const base = join(options.stateRoot, "desktops");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await realpath(base);
  const release = acquireDesktopOwnership(join(root, "ownership.sqlite"));
  let settings: DesktopSettings | undefined;
  try {
    const profilesRoot = join(root, "profiles"),
      runtimeRoot = join(root, "runtime");
    await mkdir(profilesRoot, { recursive: true, mode: 0o700 });
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    await recoverDesktopRuntime(runtimeRoot);
    settings = new DesktopSettings({
      databasePath: join(root, "settings.sqlite"),
      validateProfile: options.validateProfile,
    });
    const service = new DesktopService(
      options,
      settings,
      release,
      profilesRoot,
      runtimeRoot,
    );
    service.start();
    await service.tick();
    return service;
  } catch (error) {
    try {
      settings?.close();
    } finally {
      release();
    }
    throw error;
  }
}
