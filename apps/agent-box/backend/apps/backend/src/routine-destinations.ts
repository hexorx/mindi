import {
  RoutineDeliveryRegistry,
  type DeliveryBinding,
  type ResolvedDeliveryTarget,
} from "@mindi/routines";

/** Suggestions resolve locally; they do not attest to provider connectivity or send. */
export function routineDestinationChoices(
  bindings: DeliveryBinding[],
  profileIds: string[],
  aliases: ReadonlyMap<string, string[]> = new Map(),
): {
  profileIds: string[];
  choices: { routing: string; targets: ResolvedDeliveryTarget[] }[];
}[] {
  const registry = new RoutineDeliveryRegistry(bindings);
  return bindings.flatMap((binding) => {
    const granted = binding.profileIds.filter((profileId) =>
      profileIds.includes(profileId),
    );
    if (!granted.length) return [];
    return [
      {
        profileIds: granted,
        choices: [
          ...(binding.home ? [binding.platform.toLowerCase()] : []),
          ...(aliases.get(binding.id) ?? []).map(
            (alias) => `${binding.platform.toLowerCase()}:${alias}`,
          ),
        ].map((routing) => ({
          routing,
          targets: registry.resolve(granted[0]!, routing),
        })),
      },
    ];
  });
}
