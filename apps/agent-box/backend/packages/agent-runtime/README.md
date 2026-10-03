# Agent runtime

`@mindi/agent-runtime` owns profiles, conversation identity, native checkpoint references, runs and replay events. It accepts an `AgentWorker`; it does not import OMP, ACP, HTTP, or provider SDKs.

Use Node 22.13 or newer. The runtime uses Node's built-in SQLite API, which is still experimental in Node 22/23. Each database has one live runtime owner. WAL, foreign keys and transactions protect persisted transitions; a run and its initial event are recorded together, as are the completed checkpoint, terminal state and terminal event.

`createThread`, `startTurn`, `waitForRun`, `getRun`, `listRuns`, `events`, `branchPoints`, `forkThread`, `cancelRun`, and `close` form the conversation interface. Model IDs must belong to the configured profile. A run snapshots the selected model and profile revision. The private request record includes the profile snapshot. Caller-supplied worker executables, paths and memory banks are not part of this interface.

One thread can have one active turn or branch operation. Independent threads can run concurrently. Request idempotency keys are scoped to a thread and survive restart; different input under an existing key is a conflict. Subscriber disconnect does not cancel work. Workers must observe AbortSignal and settle only after their owned processes stop.

Events use `version: 1` and a monotonically increasing per-run sequence. `events(runId, after)` returns up to 1,000 events, allowing cursor-based replay. Thread and run listings currently return at most 1,000 records; pagination and retention policies are follow-on work. Output is limited to 64 KiB per event, 2 MiB per run and 8,192 worker events. Persisted user text is limited to 128 KiB.

## Recovery limits

A fresh owner checks unfinished runs. If the recorded worker PID is confirmed absent, the run becomes `interrupted`; it is never automatically retried. If the PID is alive or missing, it becomes `attention_required` and further writes or branch operations on that thread are blocked. PID reuse is handled conservatively by blocking, never by killing an unrelated process. A later restart rechecks recorded PIDs. There is no operator reconciliation API yet for an unrecorded PID; preserve state for investigation and use a separate new conversation only after resolving possible external work.

These are conversation recovery rules, not a durable task executor or exactly-once external-action guarantee. A failed storage commit stops new runtime operations and leaves incomplete durable state for recovery. Shutdown still drains owned work and closes storage. Session files are owned by the worker; the runtime cannot roll back edits or external side effects.

Public run failures contain safe classifications and a generic message. Provider stderr and raw exceptions are never persisted in public run errors. Profile snapshots and conversation text are sensitive local data; the composition root creates its state directory with owner-only permissions. Storage encryption and multi-user tenancy are outside this slice.

## Managed persona settings

`createProfile({ id, templateId, instructions })` creates a persistent persona from a configured template. `getProfile(id)` returns its operator settings and opaque revision; `updateProfile(id, { expectedRevision, instructions?, defaultModelId?, tools? })` uses optimistic concurrency. Allowed model/tool choices come from trusted configuration. Memory endpoints are not editable here, and a managed persona receives its own immutable bank identity.

`deleteProfile(id, expectedRevision)` removes a managed persona from the available roster and reserves its id permanently. Historical threads and runs remain readable. Deletion rejects active turns, native branches and unresolved worker ownership. Configuration-owned personas are removed through startup configuration; persisted overrides do not resurrect a removed configured persona. Current trusted configuration governs availability on restart.

Schema version 2 adds profile records without rewriting conversation history. Settings commit to SQLite before changing the available roster, and each turn captures its profile before asynchronous work begins.

## Interactions

Each runtime-created worker input provides `requestInteraction(request, signal?)`. Choice requests supply a prompt and offered `{ id, label }` pairs; text requests supply a prompt and optional maximum length. `listInteractions(runId)` exposes durable request state; `respondInteraction(runId, id, response)` validates and commits a response before resolving its worker promise.

Explicit answers and cancellations are immutable and retryable. Automatic expiry/cancellation and restart interruption never become an approval. Lifecycle records without an explicit operator response omit `response`. Schema version 3 adds interactions and their replay events; the ownership transaction migrates and invalidates old pending requests before exposing the runtime. Requests are bounded and exact data objects. Storage failures abort workers and resolve waiting requests with cancellation, leaving durable uncertainty for recovery.

Profile `approvalMode` is a revisioned setting (`always-ask`, `write`, `yolo`).
Missing configured or legacy managed values resolve to `always-ask`; invalid
explicit values are rejected or make persisted profiles unavailable. Updates
capture a new profile revision without changing an active turn's snapshot.

Trusted task turns carry a task/attempt context in idempotent run identity and the
captured worker input. One validated structured outcome is replayed as an event;
`Run.taskOutcome` becomes authoritative only alongside completed terminal state.
Failed/cancelled turns do not publish an authoritative task result.

`inspectRunOwnership` and `reconcileRun` support operator recovery. Actual active
runs, known live PIDs and surviving POSIX process groups block reconciliation.
Unknown identities require explicit `confirmStopped:true`; reasons persist and
identical confirmations can be retried. These operations never kill arbitrary
processes or replay interrupted prompts.

### Durable attachments

`RuntimeOptions.resolveAttachments(thread, ids)` synchronously verifies storage ownership
and resolves canonical base64 bytes. The runtime additionally verifies ID order,
profile/thread or channel ownership, size, and SHA-256. The backend resolver owns exact
channel branch mapping. Turn input accepts at most 16 unique attachment IDs; a file-only
turn requires at least one verified current attachment. Run history stores current
`attachments` metadata, never bytes.

Private `workerAttachmentSources` and `workerAttachmentMetadata` on runs and reply
contexts bind inherited files to their original threads and immutable metadata. Public
serializers must omit both private fields. An explicit Reply derives them only from the
selected completed run. Nested Replies retain that ancestry; worker invocation resolves
all files again against their original threads and compares metadata before dispatch.
No seed turn is generated. Current plus inherited files are bounded at 64 files,
32 source groups, and 24 MiB raw bytes; exceeding any limit fails without truncation.
These limits are checked before persistence and the byte bound again before dispatch.
Ordinary earlier turns are not automatically reattached to every new prompt: the worker
owns persistent original materialization paths for later native Read access.

`WorkerInput.resolveHistoricalAttachment(id)` lazily resolves prior durable admissions for an active run. It reads completed earlier runs in the current thread and parent history strictly before each recorded user-entry branch checkpoint. Unknown checkpoints grant no parent history. Inherited reply admissions retain their original source thread. Each lookup revalidates original storage ownership and compares immutable metadata; failed turns, sibling threads, later parent turns and merely staged files are excluded. The callback is unavailable after cancellation or completion. This does not eagerly reattach files or enlarge per-turn attachment budgets.
