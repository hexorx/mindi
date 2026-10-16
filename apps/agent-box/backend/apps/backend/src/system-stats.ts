import { cpus, freemem, totalmem, uptime } from "node:os";
import { statfs } from "node:fs/promises";
type Percent = { available: true; percent: number } | { available: false };
interface Cpu {
  idle: number;
  total: number;
}
interface Sources {
  now(): number;
  cpu(): Cpu;
  memory(): { total: number; free: number };
  hostUptime(): number;
  processUptime(): number;
  disk(): Promise<{ total: number; available: number }>;
}
const unavailable = (): Percent => ({ available: false });
function percentage(total: number, free: number): Percent {
  return Number.isFinite(total) &&
    Number.isFinite(free) &&
    total > 0 &&
    free >= 0 &&
    free <= total
    ? { available: true, percent: 100 * (1 - free / total) }
    : unavailable();
}
const duration = (value: number) =>
  Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
/** Local host observations; provider readiness and agent activity are separate. */
export class SystemSampler {
  private readonly sources: Sources;
  private previous?: Cpu;
  private pendingDisk?: Promise<Percent>;
  private readonly timeout: number;
  constructor(options: {
    workspace: string;
    diskTimeoutMs?: number;
    sources?: Partial<Sources>;
  }) {
    this.timeout = options.diskTimeoutMs ?? 250;
    if (
      !Number.isSafeInteger(this.timeout) ||
      this.timeout < 1 ||
      this.timeout > 10000
    )
      throw Error("Invalid metrics timeout");
    this.sources = {
      now: Date.now,
      cpu: () =>
        cpus().reduce(
          (sum, cpu) => ({
            idle: sum.idle + cpu.times.idle,
            total:
              sum.total + Object.values(cpu.times).reduce((a, b) => a + b, 0),
          }),
          { idle: 0, total: 0 },
        ),
      memory: () => ({ total: totalmem(), free: freemem() }),
      hostUptime: uptime,
      processUptime: () => process.uptime(),
      disk: async () => {
        const s = await statfs(options.workspace);
        return { total: s.bsize * s.blocks, available: s.bsize * s.bavail };
      },
      ...options.sources,
    };
  }
  private disk(): Promise<Percent> {
    if (!this.pendingDisk) {
      // Share the timed result as well as the read. Once timed out, callers
      // receive unavailable without attaching more callbacks to a hung read.
      const pending = new Promise<Percent>((resolve) => {
        const timer = setTimeout(() => resolve(unavailable()), this.timeout);
        void Promise.resolve()
          .then(() => this.sources.disk())
          .then(
            (s) => percentage(s.total, s.available),
            () => unavailable(),
          )
          .then((value) => {
            clearTimeout(timer);
            resolve(value);
            if (this.pendingDisk === pending) this.pendingDisk = undefined;
          });
      });
      this.pendingDisk = pending;
    }
    return this.pendingDisk;
  }
  async sample() {
    let cpu = unavailable(),
      memory = unavailable(),
      hostUptimeSeconds: number | null = null,
      processUptimeSeconds: number | null = null;
    try {
      const current = this.sources.cpu();
      if (
        Number.isFinite(current.idle) &&
        Number.isFinite(current.total) &&
        current.idle >= 0 &&
        current.total >= current.idle
      ) {
        if (this.previous)
          cpu = percentage(
            current.total - this.previous.total,
            current.idle - this.previous.idle,
          );
        this.previous = current;
      } else this.previous = undefined;
    } catch {
      this.previous = undefined;
    }
    try {
      const m = this.sources.memory();
      memory = percentage(m.total, m.free);
    } catch {
      /* unavailable */
    }
    try {
      hostUptimeSeconds = duration(this.sources.hostUptime());
    } catch {
      /* unavailable */
    }
    try {
      processUptimeSeconds = duration(this.sources.processUptime());
    } catch {
      /* unavailable */
    }
    const disk = await this.disk();
    return {
      version: 1,
      scope: "backend_host" as const,
      observedAt: new Date(this.sources.now()).toISOString(),
      cpu,
      memory,
      disk: { ...disk, scope: "workspace_filesystem" as const },
      hostUptimeSeconds,
      processUptimeSeconds,
    };
  }
}
