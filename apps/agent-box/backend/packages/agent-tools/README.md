# Agent task tools

Private loopback HTTP service over the application's TaskStore. OMP receives an
ephemeral bearer lease for one run and the profile's explicit tool grants. The
server supplies the profile identity; agents cannot choose comment authors.
Abort and process completion revoke the lease. Fork and history operations do
not receive a lease or the backend operator token.

`kanban_boards`, `kanban_list` and `kanban_get` inspect work. `kanban_create`,
`kanban_update`, `kanban_prepare` and `kanban_comment` create plans, maintain
separate parent/dependency links and prepare cards. Mutations use native OMP's
write approval tier. Operator review, worker ownership and routine policy stay
outside these tools. Routine-owned cards cannot be edited or prepared here.

Requests are bounded JSON sent to `/invoke`; origins are rejected. Native run
and tool-call identities drive durable mutation retries. SQLite binds the tool,
arguments and trusted profile to each call and enforces 64 unique calls per run
across lease renewal and service restart. Cached read results are
discarded after the final lease closes. List responses contain bounded metadata;
full card content is available through `kanban_get`.

This capability boundary is operational separation on one host, not a sandbox
against hostile processes running under the same operating-system account.
