# Hermes agent box workspace

P2 provides the flavor schema and packaged defaults. `HermesConfigSchema` extends
`@mindi/agent-box-core` with `flavor: hermes` and optional `hermes.model`;
`parseHermesConfig` gives callers a value-safe validation error.

`defaults/agent-box.json` selects one local helper profile, embedded memory, and
Tailscale disabled. It references `defaults/persona/AGENTS.md`. No GitHub account,
remote source or credential is needed to validate it. Actual inference will need
operator-selected model credentials through runtime bindings.

This workspace is a shell, not an executable container yet. The follow-on desktop
extraction adds Dockerfile, s6 and desktop assets here; later tasks add memory,
config-source loading, Tailscale and gateway wiring. Shared packages remain free
of Hermes runtime dependencies. No historical source code is imported by P2.
