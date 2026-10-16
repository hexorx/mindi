import { parseBuildInfo, type BackendBuildInfo } from "./build-info.js";
import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRuntime } from "@mindi/agent-runtime";
import type { SystemSampler } from "./system-stats.js";
export interface ComponentObservation {
  state: "ready" | "unavailable" | "unknown";
  detail: string;
  observedAt: string;
  expiresAt?: string;
}
export interface ComponentSource {
  id: string;
  required: boolean;
  observe(): ComponentObservation;
}
/** Successful owned-loop sweeps expire independently of fresh HTTP reads. */
export function ownedServiceSource(
  id: string,
  service: {
    serviceObservation(): {
      phase: "unknown" | "ready" | "attention_required" | "stopped";
      lastCompletedSweepAt?: number;
    };
  },
): ComponentSource {
  return {
    id,
    required: true,
    observe: () => {
      const { phase, lastCompletedSweepAt } = service.serviceObservation();
      const observedAt = new Date().toISOString();
      if (phase === "stopped" || phase === "attention_required")
        return {
          state: "unavailable",
          detail:
            phase === "stopped"
              ? "Owned service stopped"
              : "Owned service requires operator attention",
          observedAt,
        };
      if (phase === "unknown" || lastCompletedSweepAt === undefined)
        return {
          state: "unknown",
          detail: "No completed owned service sweep observed",
          observedAt,
        };
      const expiresAt = new Date(lastCompletedSweepAt + 30_000).toISOString();
      return {
        state:
          Date.now() - lastCompletedSweepAt >= 30_000 ? "unknown" : "ready",
        detail:
          Date.now() - lastCompletedSweepAt >= 30_000
            ? "Owned service sweep expired; refresh required"
            : "Owned service sweep completed; external access unverified",
        observedAt: new Date(lastCompletedSweepAt).toISOString(),
        expiresAt,
      };
    },
  };
}
/** Read-only observations. Configuration is never evidence of provider access. */
export class StatusProjection {
  private readonly instanceId = randomUUID();
  private sampledAt = 0;
  private metrics?: ReturnType<SystemSampler["sample"]>;
  constructor(
    private options: {
      runtime: AgentRuntime;
      stateRoot: string;
      sampler: SystemSampler;
      components?: ComponentSource[];
      build?: BackendBuildInfo | null;
    },
  ) {
    this.options.build = options.build ? parseBuildInfo(options.build) : null;
    const ids = [
      "backend",
      "runtime",
      ...(options.components ?? []).map((c) => c.id),
    ];
    if (new Set(ids).size !== ids.length)
      throw Error("Duplicate status component");
  }
  activity(input: Parameters<AgentRuntime["activity"]>[0] = {}) {
    return this.options.runtime.activity(input);
  }
  private sample() {
    if (!this.metrics || Date.now() - this.sampledAt >= 1000) {
      this.sampledAt = Date.now();
      this.metrics = this.options.sampler.sample();
    }
    return this.metrics;
  }
  async read() {
    const observedAt = new Date().toISOString();
    const activity = this.activity();
    const observations = (this.options.components ?? []).map((source) => {
      try {
        const o = source.observe();
        if (
          !["ready", "unavailable", "unknown"].includes(o.state) ||
          !o.detail ||
          !Number.isFinite(Date.parse(o.observedAt))
        )
          throw Error("Invalid component evidence");
        const expired =
          Date.parse(o.observedAt) > Date.now() + 1000 ||
          (o.expiresAt !== undefined &&
            (!Number.isFinite(Date.parse(o.expiresAt)) ||
              Date.parse(o.expiresAt) <= Date.parse(observedAt)));
        return {
          id: source.id,
          required: source.required,
          ...o,
          ...(expired
            ? {
                state: "unknown" as const,
                detail: "Observation expired; refresh required",
              }
            : {}),
        };
      } catch {
        return {
          id: source.id,
          required: source.required,
          state: "unavailable" as const,
          detail: "Local readiness observation failed",
          observedAt,
        };
      }
    });
    const providers = [
      ...new Set(
        this.options.runtime
          .listProfiles()
          .flatMap((p) => p.modelIds.map((id) => id.split("/")[0]!)),
      ),
    ]
      .sort()
      .map((id) => ({
        id,
        configuration: "configured" as const,
        verification: "unverified" as const,
        verifiedAt: null,
        evidence: "profile_model_configuration" as const,
      }));
    const stores = await Promise.all(
      ["backend", "tasks", "messaging", "routines", "artifacts"].map(
        async (id) => {
          const bytes = await Promise.all(
            [".sqlite", ".sqlite-wal"].map(async (suffix) => {
              try {
                const s = await lstat(
                  join(this.options.stateRoot, id + suffix),
                );
                return s.isFile() && Number.isSafeInteger(s.size) && s.size >= 0
                  ? s.size
                  : null;
              } catch {
                return null;
              }
            }),
          );
          return {
            id,
            databaseBytes: bytes[0],
            walBytes: bytes[1],
            recordCount: null,
          };
        },
      ),
    );
    return {
      version: 1,
      build: this.options.build ? { ...this.options.build } : null,
      observedAt,
      instanceId: this.instanceId,
      connectivity: "connected" as const,
      components: [
        ...observations,
        {
          id: "backend",
          required: true,
          state: "ready",
          detail: "Authenticated status request served",
          observedAt,
        },
        {
          id: "runtime",
          required: true,
          state: "ready",
          detail: "Current execution records read",
          observedAt,
        },
      ],
      providers,
      activity,
      metrics: await this.sample(),
      retention: { mode: "retain_all", automaticPruning: false, stores },
    };
  }
}
