# Durable team records

`MessagingStore` owns SQLite channel membership, fixed two-member DMs,
revisioned group configuration and immutable messages. Member IDs distinguish
the operator from `agent:<profileId>`. A callback validates available profiles
when assigning or targeting agents. DM identity is independent of member order.

Message retries use a durable channel/sender-scoped key. Changed input conflicts;
an exact retry returns the original message before checking mutable membership.
New posts require a member sender and a clear recipient: explicit target, one
valid mention, DM peer, group coordinator or sole other agent. Explicit null
stores a broadcast. Ambiguous routing and self-delivery fail before insertion.

Reply ancestry stays within a channel, carries the original root and derives its
hop count. Agent replies stop after eight hops. This raw store is a trusted
backend interface: native tools must bind sender and causal reply context from
the run, rather than allowing agents to reset roots through supplied arguments.

Lists use scoped cursors and limits from one to 100. Schema two migrates existing
agent-recipient messages to durable delivery intents and refuses unknown
versions. Conversation/run bindings are immutable; native completion publishes
one reply and next intent atomically. Cancellation and reconciliation records
persist independently of the process. The application-owned MessageRunner runs
agents and supplies native execution proof to this trusted storage boundary.
