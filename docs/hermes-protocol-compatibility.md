# Hermes run protocol compatibility — review candidate

This is an **opt-in, offline-tested implementation**, not P7 acceptance or an enabled runtime. Based on `main` at `e12b076`; the P7 native API launcher is still on the separate `hex-95-hermes-gateway` branch. No container service, port, nginx configuration, deployment, or model invocation is changed here.

## Source contract

NousResearch/hermes-agent tag `v2026.8.18` resolves to `e624e9fde561e1add9388384012b295fde669ade`; `hermes_cli/__init__.py` declares **0.20.4**. The tag and Opi's runtime version are consistent. Native `_handle_runs` does not read Idempotency-Key. `_handle_run_events` consumes one queue and removes it when a reader disconnects. `_handle_stop_run` returns 404 after the active task disappears. Native concurrency has a configurable admission cap, but it does not supply this queued reservation contract.

## Proposed boundary

`runtime/protocol_http.py` listens on loopback 8642, authenticates API_SERVER_KEY, and delegates native requests to loopback 8643. It runs using the pinned Hermes virtualenv, whose messaging dependencies include aiohttp 3.14.3. `protocol_compat.py` is transport-independent and uses only Python's standard library.

The API accepts POST /v1/runs, GET /v1/runs/{id}, GET /v1/runs/{id}/events and POST /v1/runs/{id}/stop. Unimplemented paths return 404. **This is not a drop-in replacement for all native API routes**: approval/steer, health, desktop chat and other inference entrypoints need integration review before enabling it. Bypassing the shim to call native inference invalidates the box-wide guarantee. All desktop callers must share the same coordinator and journal; no per-agent concurrency setting substitutes for that boundary.

Reservations are keyed by authenticated credential scope plus Idempotency-Key; the canonical request body and session header determine a conflict. Reservation commits precede inference. Concurrent retries return one stable local run ID, even before the native ID exists. Conflicting requests return 409. A single worker owns the desktop slot across caller/session boundaries. Queued stops and 300-second queued expiry invoke no model. Active stop only requests interruption; terminal polling releases the slot and retains final output/usage. Native completed/failed/cancelled status is assumed to follow execution completion in the ordinary run/stop path; forced gateway shutdown needs separate qualification.

A lost create response is ambiguous: the reservation and slot remain held, and new work receives recovery_required. The shim never retries an uncertain native create. Client create retries remain supported and do not invoke again. An exclusive journal lock prevents two shim processes from acting as the owner. Journal capacity is 10,000 reservations; capacity exhaustion fails closed, with no automatic key eviction. The runtime SQLite journal contains private request content and uses mode 0600 in a private directory; it must not enter source control or public artifacts.

## Event reconnect and explicit gaps

One independent native SSE collector survives downstream disconnects. Every event receives a monotonically increasing cursor. Reconnecting clients send Last-Event-ID; multiple clients see the same sequence without consuming each other's events. The accompanying Paperclip adapter patch sends the last processed cursor and still final-polls.

Replay memory is bounded to 4 MiB per run. An expired cursor returns 409; loss discovered midstream emits `compatibility.gap`. An upstream SSE failure or premature EOF is recorded as a gap, not represented as successful resumed delivery. **Native connection loss cannot be repaired from the native queue after its handler deletes that queue.** Events are not persisted across shim restarts. Both limitations require explicit Codi/Mindi acceptance review or upstream repair; polling-only is not accepted by this PR.

A restart with nonterminal journal entries fails closed. It preserves duplicate-key identity but requires operator reconciliation of old work before new dispatch. Do not delete the journal to clear the condition: that would destroy reservations and could duplicate inference. No automatic recovery or data-deletion procedure is authorized here.

## Verification

Install test dependencies `PyYAML==6.0.2 aiohttp==3.14.3`; then run `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`. Transport tests use an ephemeral loopback aiohttp test server and an in-memory fake backend; no native/model endpoint is contacted.

Regression tests count actual fake inference invocations and cover concurrent duplicate creates, conflicting payloads, terminal retries, cross-caller slot serialization, queued cancellation/expiry, cancellation during create, failed stop, failure release, ambiguous create, exclusive journal ownership/restart, downstream reconnect and multiple readers, cursor expiry, HTTP authentication/path restrictions, and final-result secret redaction.

## Integration and rollout review

After the P7 launcher work lands, Codi must wire a single shim owner into supervision, move the native API to 8643, route every admitted inference entrypoint through the shared slot, preserve health/control endpoints, and add supervision/configuration regressions. The current change is deliberately not activated until that integration is implemented and reviewed.

A different agent must review the exact branch head and CI before any eligible merge. Production rollout belongs to Opi and requires Josh's deployment approval, operational prerequisites, and the retest budget. Rollback must first quiesce work and confirm no inference remains, preserve the reservation journal, then restore the previous image/configuration. Do not mix old direct callers with shim callers or reset reservations. No production migration, rollout, rollback or live retest is executed by this change.
