# Owned Herdr transcript presentation

`HerdrSession` owns a new private server and explicit workspace/pane identities.
It never operates a focused session, launches Claude, submits prompts, or cancels ACP.
The trusted launcher defaults to `herdr`; deployments should pin Herdr 0.8.2 and
supply an absolute executable path. The viewer command is also trusted configuration,
for example Node with `packages/herdr/dist/viewer.js` as its argument.

Use a short private runtime root (for example `/tmp/mindi-herdr`) because Unix
socket paths are bounded. Each start creates a mode-0700 generation with separate
XDG configuration/state and disables agent resume. Every CLI request names that
session. Pane actions verify both returned pane ID and stable terminal ID. Failed
or ambiguous creation is never retried for that transcript in that generation.
After a confirmed close, a new explicit open may create another viewer for the same transcript.
The owning backend must close the session during shutdown. A retained Node guardian
leads the private process group, survives server exit, and cleans its own live group
on IPC stop or owner disconnect. The backend never signals a remembered group ID.
Guardian loss reports cleanup uncertainty. CLI deadlines use SIGKILL so ignored
SIGTERM cannot indefinitely block guardian cleanup. This supervisor targets POSIX hosts. Server death disables
new pane operations; restarting requires a new explicit generation, never adoption.

`TranscriptStore` is a single-writer backend journal; readers may use separate
instances. Call `create({id,runId,threadId,toolCallId})` before execution, then
`append(id,event)` for authoritative ACP events. `read(id,afterSeq)` returns the
identity, current status and sequenced events. The caller retains the one writer
instance per directory. Files are private, bounded and fsynced; malformed/truncated
journals fail closed. Reads use a held no-follow descriptor and a fixed bounded buffer,
including when a concurrent writer grows the file. A terminal record has reserved space even at the output
limit. Output exhaustion must cause the ACP owner to stop and record the outcome.
No journal operation resumes or replays uncertain work after restart.

`cancel_requested` records intent only. The backend must separately authorize and
send cancel to the existing ACP owner. Only its observed outcome records
`cancelled`, `failed`, or `completed`; pending cancellation cannot be overwritten
by late working events. A backend restart may record `interrupted` after determining
that the original owner is gone. Pane closure never implies ACP cancellation.

The fixed viewer validates its inherited Herdr session/pane context, tails canonical
text, strips terminal control bytes for display, and reports `custom:mindi-claude`
working/blocked/idle lifecycle to that exact pane. It relinquishes its custom
lifecycle authority on normal exit. Canonical journal text remains unchanged.

CLI/schema source: [Herdr v0.8.2](https://github.com/herdrdev/herdr/tree/v0.8.2),
`src/cli/spec.rs`, `src/session.rs`, `src/config/io.rs`,
`src/api/schema/panes.rs`, and `src/api/schema/response.rs`, and `src/api/client.rs`. Explicit workspace/pane CLI
commands return `server_not_running` on connection failure; they do not use the
interactive auto-start path.
Deterministic tests use an inert Node CLI fixture. Real Herdr pane acceptance also
passes in a disposable, network-disabled replacement image on the test host, under the
user's explicit authorization to test private sessions outside the caller's Herdr
environment. It covers text, blocked/completed states, cancellation intent and
outcome, close, and a fresh private server reopening the unchanged journal.

```sh
DOCKER_HOST=ssh://box-host MINDI_HERDR_RUNTIME_IMAGE=mindi/backend-box:replacement-final-ec56 \
  pnpm exec vitest run tests/herdr-native.test.ts
```

The test creates and removes only its own container and sessions. Journal events
are supplied by the fixture; native OMP-to-Claude permission delivery has separate
live acceptance. This test does not impersonate a live ACP process or treat pane
closure as execution cancellation.

## Backend integration

The native OMP `delegate_claude` extension writes this journal directly. Text events
are serialized before terminal outcome; persistence failure aborts the owned ACP
client. Interactive permission publishes blocked/working; the existing runtime run
signal publishes cancellation intent and drives ACP cancellation.

Backend configuration may contain
`"herdr": {"command":"/absolute/path/to/herdr","runtimeRoot":"/tmp/mindi-herdr"}`.
Omitting it disables viewers. Configuration never starts a process: the first
explicit viewer open creates the owned private server. Server-process liveness is
reported locally, without claiming provider or pane readiness. Backend shutdown
closes the owned presentation service; it never resumes delegation execution.

Authenticated API (also allowed by the native transport):

- `GET /delegations?limit=1..100&after=<uuid>` lists valid trusted associations,
  with `unavailable` for invalid/unreadable journals scanned in that page.
- `GET /delegations/<uuid>?limit=1..100&after=<seq>` returns journal status, owner `runState`, `observation` certainty, and
  at most 256 KiB of sequenced events, with `nextSeq` when more remain.
- `POST /delegations/<uuid>/viewer` with `{}` explicitly opens the fixed viewer;
  repeated requests return the same owned pane.
- `DELETE /delegations/<uuid>/viewer` with `{}` closes presentation only.
- Execution cancellation remains `POST /runs/<runId>/cancel`.

The observer validates journal run/thread associations against runtime storage.
A stopped or uncertain owner with a nonterminal journal is projected as uncertain;
the journal itself is never changed by the observer. New viewers for uncertain
nonterminal journals are refused. While a viewer is open, a bounded local owner
check closes its exact owned pane if the run loses authority without a terminal
journal; no ACP input or transcript write occurs. At most 32 viewers are owned. Terminal cancellation/failure
is written by the extension only after awaited ACP teardown. An unreadable journal
does not prevent closing a previously validated owned viewer.
It never writes a terminal outcome, adopts an unknown pane, or replays ACP on read
or restart. The directory scan is capped at 10,000 entries; larger inventories
report unavailable instead of pretending to be complete. Pre-schema legacy journals
are retained and reported unavailable, not rewritten by the observer.
