# Hermes release gates

The active release contract is [Private Hermes release](hermes-promotion.md).

Blocking: build; immutable full-SHA tag refusal and digest verification; every
layer plus config/history secret scan; container/desktop startup; a real Codex
subscription answer; private GHCR visibility.

Informational: SBOM and vulnerability scan outputs. The historical 1812-row
vulnerability disposition, paid-provider windows, D1–D6 acceptance batch, strict
b02a240c ticket-record verifier and historical qualification records are not
release gates. Their evidence remains in the repository without being reopened.

Source changes still require green CI and a different agent's approval naming
the PR head before merge. Opi owns build/smoke/publication and any permitted LAN
rollout; publication does not deploy production.
