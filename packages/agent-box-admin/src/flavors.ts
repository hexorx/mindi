// Compatibility defaults for rosters written before adapterType was supported.
// New flavors supply box.adapterType; no entry here is required.
export const legacyFlavorAdapters: ReadonlyMap<string, string> = new Map([
  ['hermes', 'hermes_gateway'],
]);
