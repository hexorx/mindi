import { RoutineError, invalid, plain, str } from "./types.js";

export interface DeliveryAddress {
  chatId: string;
  threadId?: string;
}
export interface ResolvedDeliveryTarget extends DeliveryAddress {
  bindingId: string;
  bindingRevision: number;
  platform: string;
}
/** Trusted backend configuration, never renderer-supplied transport options. */
export interface DeliveryBinding {
  id: string;
  revision: number;
  platform: string;
  profileIds: string[];
  home?: DeliveryAddress;
  resolve?: (destination: string, origin?: DeliveryAddress) => DeliveryAddress;
  normalizeOrigin?: (
    origin: DeliveryAddress,
    home?: DeliveryAddress,
  ) => DeliveryAddress;
}
type RegisteredBinding = Readonly<
  Omit<DeliveryBinding, "profileIds"> & { profileIds: readonly string[] }
>;
function platform(value: unknown): string {
  const name = str(value, "delivery platform", 64).toLowerCase();
  if (
    !/^[a-z][a-z0-9_-]*$/.test(name) ||
    ["local", "origin", "all"].includes(name)
  )
    invalid("Invalid or excluded delivery platform");
  return name;
}
function hasControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}
function identifier(value: unknown, name: string): string {
  const result = str(value, name, 1024);
  if (hasControl(result)) invalid(`Invalid ${name}`);
  return result;
}
function address(value: unknown): DeliveryAddress {
  plain(value, ["chatId", "threadId"]);
  return Object.freeze({
    chatId: identifier(value.chatId, "delivery chat"),
    ...(value.threadId === undefined
      ? {}
      : { threadId: identifier(value.threadId, "delivery thread") }),
  });
}
function bindingRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    invalid("Invalid delivery binding revision");
  return value as number;
}
function unavailable(message: string): never {
  throw new RoutineError("unavailable", message);
}

export function normalizeDeliveryRouting(value: unknown): string {
  if (typeof value !== "string" || value.length > 4096 || hasControl(value))
    invalid("Invalid routine delivery routing");
  const parts = value.trim()
    ? value.split(",").map((part) => part.trim())
    : ["local"];
  if (parts.length > 64 || parts.some((part) => !part))
    invalid("Invalid routine delivery routing");
  return parts
    .map((part) => {
      const token = part.toLowerCase();
      if (["local", "origin", "all"].includes(token)) return token;
      const colon = part.indexOf(":");
      const name = platform(colon < 0 ? part : part.slice(0, colon));
      return colon < 0
        ? name
        : name + ":" + str(part.slice(colon + 1), "delivery destination", 1024);
    })
    .join(",");
}
export function snapshotDeliveryTarget(value: unknown): ResolvedDeliveryTarget {
  plain(value, [
    "bindingId",
    "bindingRevision",
    "platform",
    "chatId",
    "threadId",
  ]);
  const bindingId = str(value.bindingId, "delivery binding id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bindingId))
    invalid("Invalid delivery binding id");
  return Object.freeze({
    bindingId,
    bindingRevision: bindingRevision(value.bindingRevision),
    platform: platform(value.platform),
    ...address({
      chatId: value.chatId,
      ...(value.threadId === undefined ? {} : { threadId: value.threadId }),
    }),
  });
}

/** Resolve routing intent once per occurrence; returned targets contain no credentials. */
export class RoutineDeliveryRegistry {
  private readonly bindings: RegisteredBinding[];
  constructor(bindings: DeliveryBinding[]) {
    if (!Array.isArray(bindings) || bindings.length > 64)
      invalid("Invalid delivery bindings");
    const ids = new Set<string>();
    const platforms = new Set<string>();
    this.bindings = bindings.map((binding) => {
      plain(binding, [
        "id",
        "revision",
        "platform",
        "profileIds",
        "home",
        "resolve",
        "normalizeOrigin",
      ]);
      const id = str(binding.id, "delivery binding id");
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id))
        invalid("Invalid delivery binding id");
      const name = platform(binding.platform);
      if (ids.has(id) || platforms.has(name))
        invalid("Ambiguous delivery bindings");
      ids.add(id);
      platforms.add(name);
      if (
        !Array.isArray(binding.profileIds) ||
        binding.profileIds.length < 1 ||
        binding.profileIds.length > 32
      )
        invalid("Invalid delivery profile grants");
      const profiles = binding.profileIds.map((value) =>
        str(value, "delivery profile", 64),
      );
      if (new Set(profiles).size !== profiles.length)
        invalid("Duplicate delivery profile grant");
      if (
        binding.resolve !== undefined &&
        typeof binding.resolve !== "function"
      )
        invalid("Invalid delivery target resolver");
      if (
        binding.normalizeOrigin !== undefined &&
        typeof binding.normalizeOrigin !== "function"
      )
        invalid("Invalid delivery origin normalizer");
      return Object.freeze({
        id,
        revision: bindingRevision(binding.revision),
        platform: name,
        profileIds: Object.freeze([...profiles]),
        ...(binding.home === undefined ? {} : { home: address(binding.home) }),
        ...(binding.resolve === undefined ? {} : { resolve: binding.resolve }),
        ...(binding.normalizeOrigin === undefined
          ? {}
          : { normalizeOrigin: binding.normalizeOrigin }),
      });
    });
  }
  platforms(profileId: string): string[] {
    str(profileId, "profileId");
    return this.bindings
      .filter((binding) => binding.profileIds.includes(profileId))
      .map((binding) => binding.platform);
  }
  private binding(name: string, profileId: string) {
    const binding = this.bindings.find((item) => item.platform === name);
    if (!binding) unavailable("Delivery platform is not configured");
    if (!binding.profileIds.includes(profileId))
      unavailable("Delivery binding is not authorized for this profile");
    return binding;
  }
  private target(
    binding: RegisteredBinding,
    value: DeliveryAddress,
  ): ResolvedDeliveryTarget {
    return Object.freeze({
      bindingId: binding.id,
      bindingRevision: binding.revision,
      platform: binding.platform,
      ...address(value),
    });
  }
  private origin(
    profileId: string,
    value: ResolvedDeliveryTarget,
  ): ResolvedDeliveryTarget {
    plain(value, [
      "bindingId",
      "bindingRevision",
      "platform",
      "chatId",
      "threadId",
    ]);
    const binding = this.binding(platform(value.platform), profileId);
    if (
      binding.id !== value.bindingId ||
      binding.revision !== bindingRevision(value.bindingRevision)
    )
      unavailable("Origin delivery binding is no longer available");
    const original = address({
      chatId: value.chatId,
      ...(value.threadId === undefined ? {} : { threadId: value.threadId }),
    });
    const normalize = binding.normalizeOrigin;
    const normalized = normalize
      ? address(normalize(original, binding.home))
      : original;
    if (normalized.chatId !== original.chatId)
      invalid("Origin normalization cannot change the delivery chat");
    return this.target(binding, normalized);
  }
  resolve(
    profileId: string,
    routing: string,
    origin?: ResolvedDeliveryTarget,
  ): ResolvedDeliveryTarget[] {
    str(profileId, "profileId");
    const parts = normalizeDeliveryRouting(routing).split(",");
    const targets: ResolvedDeliveryTarget[] = [];
    const seen = new Set<string>();
    const add = (target: ResolvedDeliveryTarget) => {
      const key = JSON.stringify([
        target.bindingId,
        target.bindingRevision,
        target.platform,
        target.chatId,
        target.threadId ?? null,
      ]);
      if (!seen.has(key)) {
        if (targets.length >= 64) invalid("Too many routine delivery targets");
        seen.add(key);
        targets.push(target);
      }
    };
    for (const part of parts) {
      const token = part.toLowerCase();
      if (token === "local") continue;
      if (token === "all") {
        for (const binding of this.bindings)
          if (binding.profileIds.includes(profileId) && binding.home)
            add(this.target(binding, binding.home));
        continue;
      }
      if (token === "origin") {
        if (origin) add(this.origin(profileId, origin));
        else {
          const home = this.bindings.find(
            (binding) => binding.profileIds.includes(profileId) && binding.home,
          );
          if (home?.home) add(this.target(home, home.home));
          else unavailable("Origin delivery has no authorized home target");
        }
        continue;
      }
      const colon = part.indexOf(":");
      const name = platform(colon < 0 ? part : part.slice(0, colon));
      const binding = this.binding(name, profileId);
      if (colon >= 0) {
        const explicit = str(
          part.slice(colon + 1),
          "delivery destination",
          1024,
        );
        if (!binding.resolve)
          unavailable("Delivery platform has no explicit target resolver");
        const matchingOrigin =
          origin &&
          origin.platform.toLowerCase() === name &&
          origin.bindingId === binding.id &&
          origin.bindingRevision === binding.revision
            ? this.origin(profileId, origin)
            : undefined;
        const context = matchingOrigin
          ? address({
              chatId: matchingOrigin.chatId,
              ...(matchingOrigin.threadId === undefined
                ? {}
                : { threadId: matchingOrigin.threadId }),
            })
          : undefined;
        // Resolver failures reject the entire plan, not a silently reduced fan-out.
        const resolve = binding.resolve;
        add(this.target(binding, resolve(explicit, context)));
      } else if (binding.home) add(this.target(binding, binding.home));
      else if (origin && origin.platform.toLowerCase() === name)
        add(this.origin(profileId, origin));
      else unavailable("Delivery platform has no home target");
    }
    if (!targets.length && parts.some((part) => part.toLowerCase() !== "local"))
      unavailable("No authorized routine delivery targets are available");
    return targets;
  }
}
