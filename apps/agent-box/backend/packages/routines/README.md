# @mindi/routines

Durable routine configuration and occurrence history in a dedicated SQLite database (Node 22.13+). Uses WAL, immediate transactions, a schema-version gate, and a unique partial index preventing more than one queued, running, or attention-required occurrence per routine.

`RoutineStore` accepts `{ databasePath, now?, validateTarget?, resolveDelivery? }`. It exposes `create`, `update`, `get`, `list`, `trigger`, `enqueueDue`, `getOccurrence`, `listOccurrences`, `listOpenOccurrences`, `bindTask`, `bindAttempt`, `finish`, and `close`. Lists return `{ items, nextCursor? }`; limits are 1–100 and cursors are scoped to each query.

Creation and manual triggers require idempotency keys. Identical retries return the original immutable result before checking current revisions or target availability. Edits require `expectedRevision`; profile and board targets are immutable. Soft deletion preserves history and cannot be reversed. Prompts are bounded at 50,000 characters. Returned objects are detached from stored JSON.

Schedules support one UTC timestamp, integer intervals of 1–525,600 minutes, or deterministic five-field cron in an IANA timezone. Cron uses pinned `cron-parser` 5.10.0. Six-field cron and randomized `H` expressions are rejected. `normalizeSchedule` validates and normalizes schedules; `nextRunAt` calculates the next timestamp.

Due work coalesces missed runs into one occurrence using the original due timestamp, advancing the next interval from its existing anchor or cron from the current time. Once schedules become exhausted (`nextRunAt: null`). Open occurrences defer further enqueueing. Pausing preserves the stored due time and permits manual triggers; editing a schedule calculates its next due time from now. Schedule advancement does not change the configuration revision.

Task bindings retain queued state; attempt bindings move queued occurrences to running. Identical bindings preserve subsequent state. Finishing as attention-required keeps the occurrence open without an end timestamp; review, blocked, and cancelled release the overlap guard. Identical terminal finishes are idempotent and contradictory terminal changes conflict.

`RoutineScheduler({routines,tasks,runner})` exposes `start`, coalesced `tick`,
`status` and `close`. The application starts one scheduler with a one-second
interval and drains it before TaskRunner shutdown. Open occurrences paginate;
the sweep yields between them. Storage errors halt scheduling with a sanitized
attention status and require repair/restart. Capacity conflicts retain queued
work; invalid or missing targets block only the affected occurrence.

Each occurrence owns one task through an immutable `routineOccurrenceId` and a
unique task index. Ordinary board dispatch ignores these cards; routine policy
owns their automatic admission. Task creation and task/attempt binding gaps are
adopted on recovery. An uncertain attempt remains attention-required until an
operator reconciles it; reconciliation does not automatically retry that task.
Pause/delete cancels queued scheduled work, while already admitted work continues.
Manual triggers work while paused. Operator task cancellation and review use the
existing task APIs.

The occurrence retains its actual task outcome summary, and HTTP history links
its task, attempt, native run and conversation. An optional internal channel and
branch destination creates publication intent atomically with the terminal
outcome. `RoutinePublisher` publishes the literal result, adopts an existing
message after an interrupted receipt, and retries publication independently of
execution. A review outcome means ready for human review, not operator acceptance.

`RoutineDeliveryRegistry` is the external-destination resolution prerequisite.
Backend-owned bindings declare platform, identity/revision, profile grants, home
target and optional explicit-target/origin-normalization callbacks. `resolve`
supports local, origin, all, platform defaults and comma-separated explicit
targets, returning immutable target objects without credentials. The adapter
owns platform-specific destination syntax. Unavailable requested routing fails
explicitly; an origin cannot switch bindings or chats during normalization.
`RoutineStore` accepts optional `deliver` routing intent and a trusted backend
`resolveDelivery(routine)` callback. Each occurrence freezes its resolution at
admission; unavailable routing records a redacted blocked delivery plan without
preventing execution or other due routines. Local-only routing never calls the
external resolver. Clearing routing affects future occurrences only.

Schema version 3 adds a durable per-target outbox and attempt ledger. Terminal
outcomes install exact output, targets and stable request keys atomically with
internal publication. Legacy occurrences acquire no invented targets. Access
`store.deliveries` for scoped pages, claim, confirm, uncertain, block, reject and
explicit retry operations. Claim and pre-send block require the inspected
revision; retries require both expectedRevision and an idempotency key. Attempts
cannot be reused. Ambiguous sends remain unavailable for retry; a positive late
receipt can resolve them. A confirmed peer is unaffected by another target's
failure, and delivery retry never invokes execution.

Schema version 4 adds `store.deliveries.operations`: an immutable ordered plan
and independent claim/receipt state for message, thread and attachment operations.
Only the active parent attempt can claim a part, and all earlier parts must be
confirmed. A parent cannot be confirmed with incomplete parts or rejected with
unresolved sends. Parent uncertainty atomically marks sending parts uncertain.
After positive part reconciliation, `continueOperations` provides a separate
revision/idempotency-fenced continuation for remaining pending/rejected parts;
lookup itself never sends. Confirmed parts survive retry and cannot be claimed
again. The publisher supplies a scoped optional third argument to adapter callbacks:
`send` gets prepare/list/claim/confirm/reject and `reconcile` gets only list/confirm.
Methods expire when the invocation returns, is aborted or the publisher closes;
no raw store or caller-selected delivery ID is exposed. Existing direct
single-message callers may omit the context. Publisher `continueOperations`
rejects concurrent invocations and schedules the usual binding-checked sweep only
after explicit continuation. Authenticated backend/native transport now exposes a payload-free progress
snapshot at `GET /routine-deliveries/:id/operations` and explicit continuation at
`POST /routine-deliveries/:id/continue` with expectedRevision/idempotencyKey.
Queries and unsupported methods are rejected. Desktop rendering and the
continuation control are not yet implemented.

`RoutineDeliveryPublisher` serializes sends, checks current binding identity,
generation and profile grants, persists claims before dispatch, and records only
positive receipts as delivered. Throws/lost responses become uncertain. Timeout
halts new admission and aborts the adapter; close aborts outstanding work, retains
receipts received while the store is still owned, and fences later callbacks.
The application holds its exclusive ownership lock through publisher shutdown.
Startup changes interrupted sending records to uncertain, never pending.

The backend accepts `deliver` on routine create/update, lists records at
`/routines/:id/external-deliveries`, and exposes get/status plus revision-checked
retry and receipt reconciliation under `/routine-deliveries`. Reconciliation is
read-only at the provider and confirms only a positive original receipt. Retry
requires an idempotency key and cannot rerun routine execution. Service readiness
reports the publisher loop, not successful delivery of every record.

Backend embedding may supply trusted `routineDeliveryAdapters`; no renderer can
supply transports or credentials. The backend includes Slack and Discord guild
text/thread/forum and Telegram text/topic adapters with operator configuration. Telegram attachments and two-way conversations, remaining
Discord DM/media/tagged-forum capabilities and authorized external acceptance remain
required. Desktop routing, per-target history/recovery, per-operation progress and
explicit continuation are implemented.
Disposable loopback tests establish orchestration and HTTP recovery only.
