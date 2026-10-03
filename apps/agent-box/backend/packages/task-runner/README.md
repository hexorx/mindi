# @mindi/task-runner

Coordinates durable task attempts with AgentRuntime and its native worker. Create
one runner for each owned application runtime. The runner handles manual dispatch,
heartbeats, observed completion, cancellation and restart reconciliation. It does
not implement cross-board fairness or distributed scheduling.

`new TaskRunner({runtime,tasks,leaseMs?,maxConcurrent?})` checks persisted unsettled
attempts. A matching, already terminal run can settle its recorded outcome without
repeating native work. Everything else becomes attention-required. `dispatch`
requires a task revision and idempotency key; it records a thread before starting
the turn and binds the run synchronously before deferred worker execution. A
binding failure cancels the deferred run. Each attempt uses its own conversation
and the immutable task snapshot. Uncertain attempts retain concurrency slots until reconciled. Missing assignees, busy profiles and oversized
native instructions fail before claiming.

`wait(attemptId)` observes owned completion. `cancel(attemptId)` persists intent
before abort and retains ownership until the runtime observes stopped execution.
Normal missing/invalid targets do not affect other work. Storage failures stop
admissions and abort owned work; shutdown attempts every cancellation even when
one persistence write fails. A cancellation response is not an exit acknowledgement.

`reconcile(taskId,{expectedRevision,reason,confirmStopped?})` checks associated
native ownership before returning work to todo for explicit preparation and retry. Known live processes
and surviving process groups cannot be overridden. Unknown launch identity needs
operator confirmation; no task is automatically relaunched. A successful worker
result becomes review, never done. Operator acceptance is a separate task action.

Only the trusted coordinator may call TaskStore's bind/observed-settlement methods.
They are not worker tools or HTTP APIs. Workers use the native task_result report,
which becomes authoritative only when their runtime run completes successfully.
Run/context identity must match the recorded attempt before settlement.

`new TaskDispatcher({tasks,runner,intervalMs?})` creates one application-owned
scheduler; construction does not start it. `start()` starts an immediate sweep
and periodic sweeps (default 1000 ms, integer range 100–60000). `tick()` runs one
sweep and coalesces overlapping calls into the same promise. Boards default to
manual. Only visible, automatic boards supply assigned ready or triage cards.
Ready cards execute; triage cards decompose through the same attempt lifecycle. Selection
orders each board's candidates by priority (0 first), creation timestamp, then
ID. Boards and cards are read in pages of 100 with event-loop yields; ready
candidates are held for the current board to preserve ordering across pages.

Each admission calls the runner with `automatic:true`, the selected revision,
and a stable task/revision idempotency key. Atomic claims recheck board policy,
revision, dependencies, ownership, and capacity. Busy assignees, capacity limits,
invalid cards and missing profiles are skipped without consuming the card.
Attention-required work is never automatically requeued and retains its runner
capacity and assignee slot. No queued card promises that capacity is reserved.

`status(boardId)` returns `{boardId,mode,revision,phase,scheduling,fault?}`.
`phase` is auto, pausing, paused, attention_required, or stopped. Archived boards
are paused. `scheduling` counts the board selection currently draining (0 or 1),
not native executions. Switching to manual prevents further claims and reports
pausing until the selection drains; paused can coexist with running workers.
Unknown/storage/closed errors halt periodic admission and expose only a fixed,
sanitized fault; recovery requires an operator and a replacement dispatcher.

`close()` stops and drains scheduling. It does not cancel workers or close the
runner/store/runtime, and subsequent `start()` or `tick()` cannot admit work.
Application shutdown should close the dispatcher before closing the runner.

`decompose(taskId,{expectedRevision,idempotencyKey,automatic?})` admits an assigned
triage card. Its profile must grant kanban_get, kanban_list, kanban_create,
kanban_update and kanban_prepare. The attempt records `purpose: "decompose"`;
ordinary execution keeps its existing absent purpose and retry identity.
Planning and coding share capacity, assignee slots, leases and native recovery.

The native planner receives exact board and parent identities and instructions to
inspect existing children, create at most ten actionable children, distinguish
parent links from dependencies, and finish with task_result. This is a prompt
bound, not a storage quota. Successful planning leaves attempt history in review
and the parent in todo; it does not satisfy the implementation contract. Failed
or explicitly blocked planning leaves the parent blocked. Manual policy drains
planning admissions without cancelling already admitted planners.

Reconciliation of uncertain planning also returns the card to todo. To plan again,
an operator deliberately transitions it to triage and uses a new request key (or
enables automatic admission). Reconciliation alone does not schedule another run.
