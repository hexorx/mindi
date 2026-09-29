# P7 protocol qualification candidate

This branch integrates the protocol shim onto the maintained P7 launcher
(`hex-95-hermes-gateway`). It changes image source/configuration only. It has not
been deployed and does not authorize live inference, upstream publication, or P7
acceptance. Independent exact-head review and green CI are required before merge.

## Ownership and ingress

s6 runs one foreground native gateway on loopback 8643 and one shim on loopback
8642. The shim runs under the Hermes virtualenv as the hermes user. An exclusive
journal lock prevents a second owner. nginx's only API upstream is the shim;
8443 remains the only exposed container port.

nginx admits run creation/status/events/stop, cancellation by reservation,
health, approval and steer. Every other /v1, /api, /health and /p route is denied,
including chat/completions, responses, session chat/stream, jobs, platform
callbacks, cron and profile mirrors. The desktop fallback still targets the
static noVNC service, not the native API. Box-wide serialization applies to
callers using this configured ingress; direct execution inside the container
is outside this HTTP boundary.

Every admitted route authenticates API_SERVER_KEY. Approval and steer resolve a
local, owned run ID to its native ID and require an active run; they cannot
create work or select an arbitrary native URL. Health forwards to native health
and reports 503 while reconciliation holds ownership. Invalid authorization
never reaches native control routes.

## Reservations and bounded memory

A durable reservation precedes dispatch. Idempotency uses credential scope,
key, body and session; conflicting repeats fail. All sessions share one worker.
Stop acknowledgement never releases the slot: observed terminal status does.
Queued cancellation and timeout invoke no inference. Cancellation by reservation
creates a tombstone if necessary, preventing delayed create from redispatching.

Defaults are deliberately finite:

| Resource | Limit / behavior |
| --- | --- |
| Reservations | 256; capacity backpressure, no automatic key eviction |
| Replay per run | 1 MiB |
| Replay process-wide | 8 MiB serialized bytes and 8,192 events |
| SSE subscribers | 16 process-wide; excess clients rejected |
| In-flight delivery | 1 MiB serialized bytes process-wide; one payload per reader |
| SSE write | 2 seconds, then disconnect; charged delivery released |
| Native JSON response | 256 KiB wire and reserialized JSON |
| Native SSE frame | 64 KiB, including multi-line and incomplete frames |
| Inbound request / canonical reservation | 256 KiB |
| Persisted snapshot | 1 MiB; checked before write and before loading old rows |
| Native error response | Body not read or forwarded; constant error code |

Replay uses global oldest-event eviction, with per-run accounting and bounded
event counts to constrain Python-object overhead. The byte budget describes
serialized replay, not total Python RSS. At most 256 bounded request/status
snapshots remain resident; journal capacity needs an explicitly approved
retention design before long-lived production use. No reservation deletion is
part of recovery. Subscribers never snapshot the replay deque across yields.
Each paused reader holds at most one charged event; global eviction cannot hide
that delivery from its separate byte budget. Redaction/serialization copies and
transport buffers are bounded by the subscriber count and native frame limit.

Native reads stream in 4 KiB chunks with an 8 KiB client read buffer. Oversized
content-length and chunked bodies fail; automatic decompression and redirects
are disabled. SSE limits apply even without newlines or frame separators.
Transport errors never forward native error bodies. HTTP payload redaction
covers credential occurrences in values and keys. Oversized native status fails
closed with an explicit gap and retains ownership.

## G6: native connection loss

A collector survives downstream disconnects, and downstream cursors replay
retained events. Expired/invalid cursors return 409, or compatibility.gap after
stream headers. Native EOF/loss without a terminal event sets sticky event_gap
in status and results. Polling cannot clear it.

The offline native-loss fixture closes an actual chunked TCP response after a
delta. The real adapter-to-shim test requires nonzero exit and preserves final
output with event_gap. This qualifies the bounded exception, not restoration of
lost native events. The upstream collector/replay repair remains tracked in
the HEX-122 gap register; normal-operation native gaps invalidate the exception.

## G7: shutdown and restart

Shutdown cancels local collection, marks gaps, and makes bounded stop requests
for known nonterminal native runs. The application shutdown hook cancels SSE
handlers before aiohttp drains requests, then attempts all known orphan stops
concurrently within one 2-second budget. The production runner uses a 3-second
HTTP shutdown timeout (aiohttp may use it for each of two drain phases), below
s6's 15-second kill deadline. The journal is retained. On restart,
nonterminal reservations become unknown with event_gap and block new dispatch.
A background reconciler requests stop and polls known native IDs until native
termination is confirmed, then marks the local run failed with output retained.
A stop acknowledgement alone never frees ownership.

Unknown create outcomes without a native ID remain blocked for operator/native
reconciliation; no retry or guessed ID is used. Duplicate keys always retain
their reservation and never dispatch a second time. Restored terminal history
also reports event_gap because replay itself is not durable. Never delete the
journal to bypass this condition.

## Offline verification

Install requirements-test.txt and nginx, then run repository build, lint,
typecheck and tests. NGINX_BINARY can select a scratch-extracted nginx binary.
The ingress test starts the shipped nginx configuration with only ephemeral
loopback ports and test TLS paths substituted. It proves alternate-path denial,
authentication and shared-slot ownership across two distinct sessions/callers.

qualification_test.py covers aggregate bytes/count, concurrent eviction,
cursor loss, snapshot limits, chunked/native errors, oversized frames,
authenticated controls, native loss, exclusive restart ownership, retained
reservations and orphan reconciliation.

The unpublished Paperclip test branch adds a native TCP-loss contract test.
Run its gateway tests with HERMES_COMPAT_SOURCE pointing to this app directory.
Publishing that patch remains gated by approval e569532c; no upstream PR or
remote CI is claimed for it.

## Rollout and rollback

Opi owns any approved rollout after merge, with Josh's deployment approval and
the HEX-121 operational/budget gates. Quiesce callers before changing the image,
retain the home-volume journal, and verify health, authentication and ingress
routing before separately approved live tests. Rollback requires confirmed
termination of all native work and preservation of reservations; restoring an
older direct-native ingress while uncertain work remains is unsafe. No deploy,
migration, journal deletion or live model call is performed by this PR.

Review regressions: shutdown_test.py sends SIGTERM to the production entrypoint
with open SSE and a stalled native stop response, asserts stop before exit, and
reopens the preserved reservation. qualification_test.py uses weak references
to check actual evicted-payload retention across generations of paused readers,
plus subscriber/byte admission and delivery release.

## Native gap regression (HEX-144)

Native status `event_gap: true`, SSE `compatibility.gap`, and SSE payload
`event_gap: true` all persist the run's sticky gap before publication. Later
false/missing flags and terminal SSE cannot clear it. HTTP tests cover status,
duplicate create, stop and journal snapshots while preserving output/usage.

For a real adapter polling-wins proof, use the existing Paperclip adapter checkout
with a TypeScript loader (or a freshly built adapter with resolvable dependencies):

```sh
HERMES_ADAPTER_EXECUTE=/path/to/paperclip/packages/adapters/hermes/src/gateway/server/execute.ts \
  node --import /path/to/tsx/dist/loader.mjs --test \
  apps/agent-box-hermes/test/native_gap_contract.test.js
```

The fixture uses native HTTP/SSE, the production Gateway and coordinator, and the
real adapter. It holds downstream SSE pending, asserts zero delivered adapter
events, and independently checks authoritative HTTP and journal gap truth.
All three cases fail on the pre-fix shim and pass with the repair. Ordinary CI
skips this cross-repository test when the adapter path is unset; HTTP coverage
always runs. No adapter source modification or publication is needed.

For this repair, Opi owns the LAN-only rollout after Devi's exact-head review,
green CI and Mindi's merge. Preserve the journal and quiesce/confirm native work
has stopped before replacing the image. Roll back to the previous image while
retaining the home volume and reservations; the previous image has the known
native-gap defect, so keep callers quiesced pending a corrected image. Keep
consent/approval semantics and the live test window unchanged. Production and
GHCR publishing remain outside this repair.
