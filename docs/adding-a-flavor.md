# Adding an agent box flavor

A flavor is one kind of agent box: a container image plus the runtime that makes
it an agent. `apps/agent-box-hermes` is the first extracted flavor. This page
covers what a new flavor provides, what it shares, and how it registers in
Paperclip without any Hermes code.

## Layout

```text
apps/agent-box-<flavor>/   Dockerfile, s6 services, desktop, runtime, defaults, tests
stacks/agent-box-<flavor>/ compose files for that flavor only
packages/agent-box-core/   flavor-neutral config, roster, identity, redaction, health
packages/agent-box-admin/  flavor-neutral registration CLI
```

Keep Dockerfiles, shell scripts, s6 definitions and harness-specific
configuration inside the flavor app. A new flavor must not import from
`apps/agent-box-hermes` or copy its files by reference; copy what you need and
own it.

## What a flavor shares

`@mindi/agent-box-core` contains no Hermes code. A new flavor uses it as-is:

- `AgentBoxConfigSchema`: a strict envelope with `schemaVersion: 1`, a `flavor`
  name (`^[a-z][a-z0-9-]{0,63}$`), `identity.name`, an optional persona
  instructions file, `memory` (`embedded`, `file` or `external` with an HTTPS
  endpoint) and `network.tailscale`. Flavors extend it with their own settings;
  runtime secrets, executable hooks and environment maps never go in it.
- `RosterBoxSchema`: a secret-free roster entry (box ID, flavor, HTTPS endpoint,
  image digest, config revision, credential reference, declared capabilities)
  plus an optional `adapterType`, the Paperclip adapter that drives the box.
- Identity, redaction and health contracts.

## Checklist for a new flavor

1. Create `apps/agent-box-<flavor>` as a private `@mindi/agent-box-<flavor>`
   workspace with `build`, `lint`, `typecheck` and `test` scripts, following the
   root [README](../README.md#adding-an-app-or-package).
2. Depend on `@mindi/agent-box-core` with `workspace:*` and validate the box
   configuration with `AgentBoxConfigSchema` (extended with your flavor's keys).
3. Run one agent per container as a documented non-root user (the published
   backend box uses `hermes`, UID/GID 10000), with persistent state under
   `/home/agent`. No Docker socket, host network, privileged mode or host home
   mount.
4. Take credentials only as runtime files or a login stored in the home volume.
   Never use build arguments, image layers, Git or CI output for them.
5. Boot with no GitHub account and no Tailscale. Make optional networking a
   separate compose overlay in `stacks/agent-box-<flavor>/`.
6. Expose an authenticated health endpoint and test boot, health, restart with
   the same volume, and shutdown in CI.
7. If the flavor is published, add its own release workflow and image name.
   Do not reuse `ghcr.io/hexorx/agent-box-hermes`.
8. Document run, login, rollout and rollback for the flavor, in the shape of the
   [operator guide](operator-guide.md).

## Registering a new flavor in Paperclip

`agent-box-admin` reads the adapter from the roster, so a new flavor needs no
admin or Hermes code changes. Set `box.adapterType` to the Paperclip adapter
installed for the flavor, for example:

```json
{ "flavor": "example", "adapterType": "example_gateway" }
```

The adapter identifier matches `^[a-z][a-z0-9_-]{0,63}$`. Admin uses it for the
hire, the adapter environment test and the ownership checks during reconcile.
The adapter and box must implement the shared gateway contract:

- The adapter accepts `apiBaseUrl`, an `apiKey` secret reference,
  `sessionKeyStrategy: "issue"` and `paperclipApiUrl`.
- The box serves an authenticated `/health` endpoint at that base URL.

Adapters with a different configuration shape are not supported by this CLI.
Hermes rosters may omit `adapterType`: a compatibility default resolves
`hermes` to `hermes_gateway`, and no other flavor has a default. Keep the field
unchanged when resuming an operation, because it is part of the request
fingerprint. Details are in the
[admin README](../packages/agent-box-admin/README.md#flavor-adapter-contract).

The published image `ghcr.io/hexorx/agent-box-hermes` is built from
`apps/agent-box`, the original backend box, and is not registered with Paperclip;
see the [operator guide](operator-guide.md#register-in-paperclip).
