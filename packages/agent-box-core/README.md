# Agent box contracts, version 1

Shared, cross-flavor contracts for parsed JSON/YAML data. Import the Zod schemas
or inferred TypeScript types from `@mindi/agent-box-core`. Use `parseContract`
at an input boundary: it throws a fixed diagnostic without raw values or unknown
field names. Direct schema errors are useful for local development but must not
be logged against untrusted input.

- `AgentBoxConfigSchema`: strict common manifest with version, flavor, display
  name, optional persona file, embedded/external memory and Tailscale selection.
  Flavor apps extend the envelope with strict, flavor-specific configuration.
- `BoxIdentitySchema`: UUID v4 plus mutable display name. `createBoxIdentity`
  generates a new identity; the runtime must persist it once, independently of
  manifest refreshes. `renameBoxIdentity` retains the ID. `memoryBankId` derives
  an isolated namespace from that ID, never from the name or a GitHub account.
- `RosterSchema`: strict versioned list of unique boxes/endpoints, immutable image
  digest and resolved config revision (full Git SHA or `sha256:<64 hex>`), symbolic
  credential reference, capability claims and nullable company/agent binding.
  Optional `adapterType` identifies the Paperclip gateway adapter supplied by a
  flavor; it is data, not an executable plugin or credential.
  A binding contains exactly one company and agent; an agent cannot appear twice.
- `BoxHealthSchema`: timestamped component observations with bounded diagnostic
  codes. `isRegistrationReady` requires container, desktop, memory and API health,
  plus config-source/network health when required by operator settings. Disabled
  Tailscale and optional source fallback do not prevent readiness.
- `redact`: removes secret-bearing fields recursively and replaces all supplied
  runtime secret values, including occurrences in strings and property names.
  It does not discover unknown credentials hidden in arbitrary prose. Prefer
  bounded health codes; never log raw runtime/config-source responses.

All objects reject unknown fields instead of stripping them. Secret values,
secret file paths, environment maps, arbitrary hooks and plugins are not manifest
fields. `apiCredentialRef` is only a lowercase symbolic lookup key, such as
`helper_api`; runtime secret loading and provider-specific references belong in
operator-controlled bindings. Schemas cannot identify a secret intentionally put
in a free-text name/model field; keep runtime credentials out of all input data.

Paths are portable relative paths: no absolute paths, dot segments, backslashes,
empty segments, percent encodings, leading-dot names, whitespace or shell syntax.
Readers must still enforce realpath/symlink containment beneath a trusted root.
HTTPS endpoints cannot contain credentials, queries or fragments. Parsing does
not perform network requests, enforce company authorization, prove operator
control, verify capability claims, or detect stale health observations. Consumers
must live-probe and enforce those boundaries before registering a box.

Remote-source resolution, precedence, immutable fetch records and runtime bindings
are deliberately outside this P2 package. A later resolver must prevent remote
content from overriding operator security settings and retain last-good config.

Fixtures in `test/fixtures` are synthetic valid/invalid JSON. YAML callers must
parse YAML into plain data before using these contracts. Run checks from the
repository root with `pnpm build`, `pnpm lint`, `pnpm typecheck`, and `pnpm test`.
