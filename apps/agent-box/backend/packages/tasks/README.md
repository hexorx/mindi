# @mindi/tasks

Single-host SQLite boards, task cards, comments and execution attempts. The store
owns business state and atomic claim authority independently of any scheduling
engine. It does not launch agents; the dispatcher must associate native runs,
observe cancellation, and reconcile uncertain process ownership before retrying.

`TaskStore({databasePath, now?, validateAssignee?})` opens WAL storage with schema checks. Mutations
use transactions; returned values are detached. An optional synchronous assignee
validator runs only for new task creation or explicit assignment edits, so
identical create retries do not depend on current profile availability. Creation keys persist canonical
requests and original responses, rejecting changed-key reuse. Board/task updates
require their current numeric revision. Lists use bounded, scope-bound cursors.

Boards default to manual dispatch. Automatic claims require auto policy; manual
claims still check archival, ready state, assignment and completed dependencies.
Parent decomposition and dependency order are distinct acyclic same-board graphs.
Running state is execution-owned. Workers can finish only into review or blocked;
operator review accepts into done or requests changes into todo. Operators cannot
set running/review/done by changing the task status.

Each attempt captures task instructions, assignment and acceptance contract and
returns a private fence token. Worker heartbeat and finish require a current token
and unexpired lease. `expireClaims()` marks uncertainty, never readies work for
replay. `reconcile()` records an operator explanation and makes the task todo;
it does not prove an external worker stopped. Native ownership must also be
reconciled before the next execution. Attempt list results omit tokens.

This package is a durable aggregate, not a process supervisor or OS sandbox.

The trusted runner can bind thread/run IDs, record cancellation intent and settle
an independently observed terminal native run. These association/settlement APIs
are intentionally absent from HTTP. Dispatch claim idempotency excludes the
operational lease duration so a configuration change does not turn a retry into
a new request. The admission callback runs only for new claims inside the claim
transaction; retrying an accepted request does not consume capacity again.
