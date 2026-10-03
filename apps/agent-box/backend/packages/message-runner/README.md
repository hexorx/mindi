# Native message delivery

`MessageRunner` owns automatic delivery for persisted agent recipients. It uses
one native thread per channel/profile, independently of causal reply roots.
Concurrency is capped at four, with runtime serialization inside each thread.
Thread creation and run request identities close cross-store restart gaps.

The runner adopts an existing run before applying changed admission policy or
cancelling queued work. Native identity is bound before deferred execution starts.
Known terminal runs publish one atomic reply; interrupted or uncertain runs need
operator reconciliation. Cancellation intent is durable before native abort.
Closing drains admitted work without starting queued deliveries.

Completed output is read across all runtime event pages. Messages retain a
32,000-character preview, a truncation flag and the native run ID for full output.
Replies at hop eight remain visible with blocked delivery rather than waking a
ninth agent turn. Store or identity failures halt admission and expose attention.

Call `start()` for application scheduling, `tick()` for an explicit sweep,
`status()` for operational state, `cancel(id)` for operator cancellation and
`close()` before closing runtime or messaging storage. Reconciliation is applied
through the runtime's process-aware API; the next sweep projects its proof.
