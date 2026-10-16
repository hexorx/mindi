import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  RuntimeError,
  isApprovalMode,
  type AgentProfile,
  type ProfileView,
  type UpdateProfileInput,
  type CreateProfileInput,
} from "./types.js";
interface RecordValue {
  templateId: string;
  profile: AgentProfile;
  managed: boolean;
  deleted?: boolean;
  revision?: string;
  overrides?: Partial<
    Pick<
      AgentProfile,
      "instructions" | "tools" | "defaultModelId" | "approvalMode"
    >
  >;
}
export function profileRevision(profile: AgentProfile): string {
  return createHash("sha256").update(JSON.stringify(profile)).digest("hex");
}
function invalid(): never {
  throw new RuntimeError("invalid", "Invalid profile settings");
}
function idValid(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value);
}
function instructionsValid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 100000
  );
}
function shape(
  value: unknown,
  keys: string[],
): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalid();
}
export class ProfileStore {
  private readonly records = new Map<string, RecordValue>();
  private readonly templates: Map<string, AgentProfile>;
  constructor(
    private readonly db: DatabaseSync,
    private readonly profiles: Map<string, AgentProfile>,
    configured: AgentProfile[],
  ) {
    this.templates = new Map(
      configured.map((profile) => [
        profile.id,
        {
          ...structuredClone(profile),
          approvalMode: profile.approvalMode ?? "always-ask",
        },
      ]),
    );
    for (const row of db.prepare("SELECT id,value FROM profiles").all()) {
      const record = JSON.parse(String(row.value)) as RecordValue;
      this.records.set(String(row.id), record);
      if (record.deleted) {
        profiles.delete(String(row.id));
        continue;
      }
      const template = this.templates.get(record.templateId);
      if (
        !template ||
        (record.managed && this.templates.has(record.profile.id))
      ) {
        profiles.delete(record.profile.id);
        continue;
      }
      if (!record.managed)
        record.profile = { ...structuredClone(template), ...record.overrides };
      if (record.profile.approvalMode === undefined)
        record.profile.approvalMode = "always-ask";
      if (!this.compatible(record.profile, template)) {
        profiles.delete(record.profile.id);
        continue;
      }
      profiles.set(record.profile.id, structuredClone(record.profile));
    }
  }
  private compatible(profile: AgentProfile, template: AgentProfile): boolean {
    return (
      isApprovalMode(profile.approvalMode) &&
      profile.modelIds.every((id) => template.modelIds.includes(id)) &&
      profile.modelIds.includes(profile.defaultModelId) &&
      (profile.tools ?? []).every((tool) =>
        (template.tools ?? []).includes(tool),
      ) &&
      !!profile.memory === !!template.memory &&
      (!profile.memory || profile.memory.url === template.memory?.url)
    );
  }
  get(id: string): ProfileView {
    if (!idValid(id)) invalid();
    const profile = this.profiles.get(id);
    if (!profile)
      throw new RuntimeError(
        "not_found",
        "Unknown or unavailable agent profile",
      );
    return {
      id: profile.id,
      instructions: profile.instructions,
      tools: [...(profile.tools ?? [])],
      availableTools: [
        ...(this.templates.get(this.records.get(id)?.templateId ?? id)?.tools ??
          []),
      ],
      approvalMode: profile.approvalMode ?? "always-ask",
      modelIds: [...profile.modelIds],
      defaultModelId: profile.defaultModelId,
      revision: this.records.get(id)?.revision
        ? createHash("sha256")
            .update(this.records.get(id)!.revision! + profileRevision(profile))
            .digest("hex")
        : profileRevision(profile),
      managed: this.records.get(id)?.managed ?? false,
    };
  }
  /** Includes tombstones and unavailable historical profiles; not an activity grant. */
  hasIdentity(id: string): boolean {
    if (!idValid(id)) invalid();
    return (
      this.profiles.has(id) ||
      this.records.has(id) ||
      !!this.db
        .prepare(
          "SELECT id FROM threads WHERE json_extract(value,'$.profileId')=? LIMIT 1",
        )
        .get(id)
    );
  }
  create(input: CreateProfileInput): ProfileView {
    shape(input, ["id", "templateId", "instructions"]);
    if (
      !idValid(input.id) ||
      !idValid(input.templateId) ||
      !instructionsValid(input.instructions)
    )
      invalid();
    if (this.hasIdentity(input.id))
      throw new RuntimeError("conflict", "Profile identity already exists");
    const template = this.templates.get(input.templateId);
    if (!template)
      throw new RuntimeError("not_found", "Unknown configured template");
    const profile: AgentProfile = {
      ...structuredClone(template),
      id: input.id,
      instructions: input.instructions,
      ...(template.memory
        ? { memory: { url: template.memory.url, bankId: randomUUID() } }
        : {}),
    };
    const record = { templateId: input.templateId, profile, managed: true };
    this.db
      .prepare("INSERT INTO profiles(id,value) VALUES (?,?)")
      .run(input.id, JSON.stringify(record));
    this.records.set(input.id, record);
    this.profiles.set(input.id, profile);
    return this.get(input.id);
  }
  update(id: string, input: UpdateProfileInput): ProfileView {
    shape(input, [
      "expectedRevision",
      "approvalMode",
      "instructions",
      "defaultModelId",
      "tools",
    ]);
    const current = this.get(id);
    if (
      typeof input.expectedRevision !== "string" ||
      !input.expectedRevision ||
      input.expectedRevision.length > 128
    )
      invalid();
    if (current.revision !== input.expectedRevision)
      throw new RuntimeError("conflict", "Profile revision changed");
    if (
      Object.keys(input).length < 2 ||
      ("approvalMode" in input && !isApprovalMode(input.approvalMode)) ||
      ("instructions" in input && !instructionsValid(input.instructions)) ||
      ("defaultModelId" in input && typeof input.defaultModelId !== "string") ||
      ("tools" in input &&
        (!Array.isArray(input.tools) ||
          input.tools.some((tool) => typeof tool !== "string") ||
          new Set(input.tools).size !== input.tools.length))
    )
      invalid();
    const previous = this.records.get(id);
    const templateId = previous?.templateId ?? id;
    const template = this.templates.get(templateId)!;
    const profile = structuredClone(this.profiles.get(id)!);
    if (input.instructions !== undefined)
      profile.instructions = input.instructions;
    if (input.defaultModelId !== undefined)
      profile.defaultModelId = input.defaultModelId;
    if (input.approvalMode !== undefined)
      profile.approvalMode = input.approvalMode;
    if (input.tools !== undefined) profile.tools = [...input.tools];
    if (!this.compatible(profile, template)) invalid();
    const record: RecordValue = {
      templateId,
      profile,
      managed: previous?.managed ?? false,
      revision: randomUUID(),
    };
    if (!record.managed) {
      record.overrides = { ...previous?.overrides };
      for (const key of [
        "instructions",
        "defaultModelId",
        "tools",
        "approvalMode",
      ] as const)
        if (key in input)
          Object.assign(record.overrides, { [key]: input[key] });
    }
    this.db
      .prepare(
        "INSERT INTO profiles(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
      )
      .run(id, JSON.stringify(record));
    this.records.set(id, record);
    this.profiles.set(id, profile);
    return this.get(id);
  }

  delete(id: string, expectedRevision: string): void {
    const current = this.get(id);
    if (
      typeof expectedRevision !== "string" ||
      !expectedRevision ||
      expectedRevision.length > 128
    )
      invalid();
    if (!current.managed)
      throw new RuntimeError(
        "conflict",
        "Configured profiles cannot be deleted",
      );
    if (current.revision !== expectedRevision)
      throw new RuntimeError("conflict", "Profile revision changed");
    const record = { ...this.records.get(id)!, deleted: true };
    this.db
      .prepare("UPDATE profiles SET value=? WHERE id=?")
      .run(JSON.stringify(record), id);
    this.records.set(id, record);
    this.profiles.delete(id);
  }
}
