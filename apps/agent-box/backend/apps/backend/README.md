# Mindi local backend

The TypeScript backend for Mindi's desktop and mobile apps: an embedded Pi coordinator, OMP specialist conversations, live speech, durable tasks, team messaging, routines, profile desktops and ACP delegation. Hindsight remains the agent memory service. Existing Hermes boxes are not cut over by building or running this application.

## Run locally

Requires Node >=22.13, pnpm, and OMP 18.1.17 with an existing native provider login. Install and build from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @mindi/backend... build
```

Create an operator-owned configuration file outside Git:

```json
{
  "stateRoot": "./state",
  "workspace": "./workspace",
  "port": 65005,
  "profiles": [
    {
      "id": "mira",
      "instructionsFile": "./SOUL.md",
      "modelIds": ["openai-codex/gpt-6-astra"],
      "defaultModelId": "openai-codex/gpt-6-astra",
      "tools": []
    }
  ]
}
```

Paths resolve relative to the configuration file. Write the persona in the selected SOUL file. Supply a strong random token of at least 32 characters through `MINDI_BACKEND_TOKEN`, then run:

```sh
node apps/backend/dist/main.js /absolute/path/to/backend.json
```

The server binds only to IPv4 loopback. Every endpoint, including health, requires `Authorization: Bearer <token>`. No CORS policy is enabled. The token is never printed. Native provider authentication stays with its harness; the backend does not copy credentials. The server and process adapter are for a trusted local operator, not a multi-tenant execution sandbox.

An empty tool list disables native tools. Profiles use `always-ask` by default for native writes/execution; `write` and `yolo` are explicit policy choices within the same tool allowlist. Native tools operate in the trusted workspace, not an OS sandbox. Questions and permissions use durable interactions; unsupported custom dialogs are cancelled. The native desktop app renders pending interactions and submits only the offered responses.

Optional profile memory is `{"url":"http://127.0.0.1:18888","bankId":"mira"}`. It configures native OMP Hindsight; a conversation completion is not proof of asynchronous memory extraction or retrieval. Use distinct banks for isolated personas. Live acceptance verified native retention, fresh-process recall, and isolation between disposable persona banks. Every run still reports `memoryState: "unverified"` when memory is enabled, because native enqueue acknowledges submission rather than extraction success.

## HTTP protocol

JSON responses use safe domain errors. Request fields are exact; arbitrary workspace, executable, bank and session-path fields are rejected. Native checkpoint paths and memory connection details are not returned. Authenticated profile detail endpoints return SOUL instructions and editable settings.

| Method     | Path                                        | Purpose                                                                                                                                   |
| ---------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GET        | `/health`                                   | Authenticated health and protocol version                                                                                                 |
| GET        | `/profiles`                                 | Available configured and managed persona/model IDs                                                                                        |
| POST       | `/profiles`                                 | Create from `id`, configured `templateId`, and `instructions`                                                                             |
| GET        | `/profiles/:id`                             | Operator settings and opaque revision                                                                                                     |
| PATCH      | `/profiles/:id`                             | Revision-checked SOUL, default model and tool settings                                                                                    |
| DELETE     | `/profiles/:id`                             | Remove a managed persona using `expectedRevision`                                                                                         |
| GET / POST | `/threads`                                  | List / create using `profileId`                                                                                                           |
| GET        | `/threads/:id`                              | Public thread identity and lineage                                                                                                        |
| GET / POST | `/threads/:id/runs`                         | History / start using `text`, `idempotencyKey`, optional `modelId`                                                                        |
| GET / POST | `/threads/:id/branches`                     | Native branch points / fork using `entryId`                                                                                               |
| GET        | `/runs/:id`                                 | Run state and safe error classification                                                                                                   |
| POST       | `/runs/:id/cancel`                          | Explicit cancellation; JSON body `{}`                                                                                                     |
| GET        | `/runs/:id/interactions`                    | Pending and resolved run-scoped questions and decisions                                                                                   |
| POST       | `/runs/:id/interactions/:requestId/respond` | Submit `{ "response": { "choiceId": "offered-id" } }`, `{ "response": { "text": "answer" } }`, or `{ "response": { "cancelled": true } }` |
| GET        | `/runs/:id/events`                          | SSE replay and live events                                                                                                                |

Managed personas persist in SQLite. Creation inherits the configured template’s model/tool allowance and allocates a distinct memory bank when memory is enabled. `PATCH` requires `expectedRevision` plus one or more of `instructions`, `defaultModelId`, and `tools`. Edits apply to later turns; running turns retain their profile snapshot. Configured profiles are removable through operator configuration only. Managed deletion preserves history and permanently reserves the identity; it rejects active or unresolved work. On a lost mutation response, reread the roster and settings before deciding what to do next.

SSE sends `event: run`, sequence in `id`, and versioned JSON in `data`. Reconnect using `Last-Event-ID` or `?after=N`. A disconnected or slow subscriber does not cancel a run; backpressure pauses output until the connection drains. The stream ends when all recorded events are sent and the run is no longer running. Attention-required recovery is not a success signal.

Use `?page=1&limit=100&after=...` for paginated thread/run history. Thread pages also accept `profileId` and `ownerKind`; authenticated list items include a bounded first-own-prompt preview. Legacy unpaged arrays cap at 1,000 and explicitly report truncation. Event replay is paged. Retention is retain-all with capacity observations; no background destructive pruning runs. Telegram routine text delivery is implemented with numeric chat/topic routing; attachments, two-way conversations and live provider acceptance remain open. Deployment cutover remains outside this implementation. See the [native app](../../infra/desktop-shell/README.md), [owned Herdr integration](../../packages/herdr/README.md) and [acceptance inventory](../../docs/design/2026-09-07-non-telegram-parity-audit.md) for verified behavior and external acceptance gaps.

## Verification

Root `pnpm check` runs deterministic Vitest process/storage/HTTP acceptance plus package lint, formatting and builds. Live provider tests are separate and must not be inferred from fixture results.

After building, run the opt-in provider acceptance:

```sh
MINDI_LIVE_ACCEPTANCE=1 pnpm --filter @mindi/backend acceptance:live
```

Set `MINDI_LIVE_CLAUDE=1` to also verify native Claude delegation. Set `MINDI_LIVE_HINDSIGHT_URL=http://127.0.0.1:18888` to verify local memory extraction, fresh-process recall and bank isolation. `MINDI_LIVE_MODEL` can select an already authenticated provider/model. The runner uses temporary workspaces, synthetic prompts and disposable memory banks; it uses real provider capacity. It retains an evidence file and cleans its memory banks.

Claude delegation requires top-level configuration `"claude": {"permissionKinds": []}` plus persona tool `"delegate_claude"`. Empty policy denies child tools; configure individual ACP kinds such as `read` only when intended. This controls ACP choices, not OS sandboxing. Existing native Claude login must be available. Read-only transcripts under the state directory include run/thread association and explicit terminal status.

See [the foundation implementation record](../../docs/design/2026-09-07-mindi-backend-foundation.md) for exact verification and follow-on work.

## Durable interactions

Enable `ask_user` in a persona's tools for questions over OMP RPC. It accepts `question` and optional `choices`; without choices it requests text. This extension is used because OMP 18.1.13's built-in `ask` is unavailable in this RPC launch configuration. Native select, confirm, input and editor frames map to the same runtime interaction records. No response is invented after timeout or disconnection.

For Claude permissions, set `"claude": {"permissionKinds": [], "interactivePermissions": true}`. Interactive mode asks for each request and only offers one-time allow/reject options. Without interactive mode, the existing configured kind allowlist applies. A cancelled or unavailable question does not authorize the child tool.

Requests and their replay events commit before exposure; responses commit before delivery to a waiting worker. App reconnects can retrieve pending requests. Identical explicit decisions can be retried without new delivery. Run cancellation, expiry and native cancellation invalidate pending requests. Backend restart marks pending requests interrupted and never revives their old permission into another process. A stored approval does not prove the external action completed.

The default interaction deadline is five minutes, with a thirty-minute maximum. Native question/Claude dialogs currently request two minutes, within the overall worker deadline. Each run allows at most 32 requests and eight pending at once. Choice/text responses are validated at both the HTTP/runtime and native protocol boundaries.

Opt-in native acceptance:

```sh
MINDI_LIVE_ACCEPTANCE=1 MINDI_LIVE_INTERACTION_BACKEND=omp pnpm --filter @mindi/backend acceptance:interactions
MINDI_LIVE_ACCEPTANCE=1 pnpm --filter @mindi/backend acceptance:interactions
```

The first command verifies native OMP questions through durable HTTP decisions. The second verifies a native Claude read permission and exact temporary-file contents. Claude's native subscription login must be valid. Neither command supplies API credentials; the harness owns authentication.

Profiles expose revisioned `approvalMode` settings through GET/PATCH profile
operations and accept them in trusted configuration. Omitted settings default to
`always-ask`: native reads are automatic, writes/execution prompt through durable
run interactions. `write` permits reads/writes automatically; `yolo` permits all
enabled tool tiers. Tool allowlists remain unchanged by mode switches. Changes
apply to future runs, including after restart; running turns retain their
captured mode. Claude child ACP permissions remain a separate trusted policy.

Durable boards and task cards are stored in `stateRoot/tasks.sqlite`:

- `GET/POST /boards`, `GET/PATCH /boards/:id`
- `GET/POST /boards/:id/tasks`, `GET/PATCH /tasks/:id`
- `GET/POST /tasks/:id/comments`, `GET /tasks/:id/attempts`
- `POST /tasks/:id/transition` with `expectedRevision`, `status`, `reason`
- `POST /tasks/:id/review` with `expectedRevision`, `decision`, `reason`

Creates require `idempotencyKey`; edits require `expectedRevision`. List responses
are `{items,nextCursor?}` with `after` and `limit` (1–100). Board/card lists accept
`includeArchived=true`; default lists exclude archived records. Comments from
these operator routes always use the authenticated operator identity. Assignees
must be available profiles. Worker claim tokens and completion operations are
not exposed by these routes. Board policy persists and gates periodic automatic
dispatch. New boards default to manual; setting auto enables ready-card execution and assigned triage decomposition.

Manual task execution is available through:

- `POST /tasks/:id/dispatch` with `expectedRevision`, `idempotencyKey`
- `POST /tasks/:id/decompose` with the same fields for an assigned triage card
- `POST /attempts/:id/cancel` with an empty JSON object
- `POST /tasks/:id/reconcile` with `expectedRevision`, `reason` and optional
  `confirmStopped` for uncertain launch identity
- `GET /runs/:id/ownership` and `POST /runs/:id/reconcile` for native run recovery

Task attempt responses include associated thread/run IDs but no claim token.
Normal run events and pending interactions remain available through existing run
routes. A worker must call native task_result and complete its turn to enter
review; operator acceptance remains separate. Ordinary chat requests cannot set
trusted task context. The application starts one TaskRunner and drains it before
closing the runtime/database. Auto policy is stored admission policy; the
periodic dispatcher checks enabled boards every second. `GET /boards/:id/dispatch`
returns current mode/revision, scheduling count and phase. Switching to manual
drains admissions (`pausing` then `paused`) without cancelling native workers.
Archived boards stop admissions too. Storage failures halt automatic scheduling
and expose a sanitized attention state; uncertain attempts require reconciliation.

After building, run `MINDI_LIVE_ACCEPTANCE=1 pnpm --filter @mindi/backend acceptance:tasks`
for real OMP file-write, operator review, restart replay, automatic admission,
manual drain and pending-interaction cancellation checks. It uses private temporary
state and existing native login.

Slack, Discord guild and Telegram routine delivery can be configured through operator-owned
`routineDeliveries` bindings and private token files. Account identity, target
generations and output receipts are checked by the backend. See the
[Slack configuration](../../docs/design/2026-09-11-omp-slack-routine-delivery.md) and
[Discord configuration and acceptance limits](../../docs/design/2026-09-11-omp-discord-routine-delivery-audit.md#september-12-discord-transport-checkpoint).
See also the [Telegram configuration](../../docs/design/2026-09-11-omp-discord-routine-delivery-audit.md#september-12-telegram-routine-transport-checkpoint).
Desktop routing, operation progress and admitted file delivery for Telegram and
Discord are implemented. Discord media channels use the same thread upload and recovery path as forums.
Two-way conversations, new DM onboarding and
authorized external acceptance remain open.

Discord bindings may set `forumTags` to a map from forum or media channel ID to one through
five explicit tag IDs, for example `"forumTags": { "123": ["456"] }`. Use real
IDs from the intended forum or media channel. Increase the binding revision when changing tags.
The backend checks that selected tags exist, includes them in the durable send
plan, and requires matching tags on creation/recovery receipts. Required-tag
forums without a configured selection remain blocked; no tag is chosen
automatically. Provider permission failures remain explicit delivery failures.

Routine schedules and run history persist in `stateRoot/routines.sqlite`:

- `GET/POST /routines`, `GET/PATCH /routines/:id`
- `DELETE /routines/:id` with `expectedRevision` preserves history
- `POST /routines/:id/trigger` with `expectedRevision`, `idempotencyKey`
- `GET /routines/:id/runs` for paginated occurrences and native run/thread links
- `GET /routines/status` for scheduler phase and sanitized fault status

Create fields are `name`, `prompt`, `profileId`, `boardId`, `schedule`, optional
`enabled` and `idempotencyKey`. Edit name/prompt/schedule/enabled with a revision.
Profile and board identities are immutable. Setting enabled false pauses future
scheduled admissions; it does not cancel admitted native work. Explicit triggers
work while paused. Lists accept `after`, `limit`; routine lists additionally accept
`includeDeleted=true`. Schedules use `{kind:"once",at:"2026-09-09T12:00:00Z"}`,
`{kind:"interval",minutes:60}` or
`{kind:"cron",expression:"0 9 * * 1-5",timezone:"America/Chicago"}`.

Occurrences snapshot the instructions and own one task. Output remains local,
and actual native completion enters review for separate operator acceptance.
Missed schedules coalesce; an open or uncertain occurrence prevents overlap.
Run `MINDI_LIVE_ACCEPTANCE=1 pnpm --filter @mindi/backend acceptance:routines`
after building for a real one-time OMP schedule, exact file/output and restart
history check in private temporary state.

Profiles can receive native planning tools by including these names in `tools`:
`kanban_boards`, `kanban_list`, `kanban_get`, `kanban_create`, `kanban_update`,
`kanban_prepare`, and `kanban_comment`. Read tools inspect work; mutation tools
use the profile's native write approval policy. Parent links and dependencies
are separate fields. New cards remain todo until explicitly prepared; manual
boards still require operator dispatch. These tools cannot approve review or
change worker ownership. Comments use the executing persona's identity.

The application opens a private, run-scoped tool connection automatically. It
does not pass the backend operator token to OMP. Run
`MINDI_LIVE_ACCEPTANCE=1 pnpm --filter @mindi/backend acceptance:agent-tools`
after building to verify native planning, attributed comments and restart in
private temporary state.

Conversation creation accepts an optional `idempotencyKey` on `POST /threads`.
An identical retry returns the original thread, including after restart; changing
the profile under the same key conflicts. Existing requests without a key still
create new threads. Creation receipts persist alongside paginated history and explicit thread ownership;
existing conversations are preserved during schema upgrades.

Team authoring is stored in `stateRoot/messaging.sqlite`:

- `GET/POST /channels`, `GET/PATCH /channels/:id`
- `POST /dms` with `recipientId` reuses the operator's DM with that member
- `GET/POST /channels/:id/messages`, `GET /messages/:id`

Members are `operator` or `agent:<profileId>`. Group creation takes `name`,
`members`, optional `coordinatorId` and `idempotencyKey`; edits require
`expectedRevision`. DM membership is fixed. Message creation accepts `text`,
`idempotencyKey`, optional `recipientId` and `replyTo`. HTTP supplies the operator
sender; callers cannot impersonate another member. Explicit null recipient means
broadcast without an agent recipient. Otherwise choose a recipient explicitly,
mention one member, or use the group's unique coordinator/sole agent. Lists use
`after` and `limit` (1–100); channel lists can filter by `memberId`.

Addressed agent messages are admitted automatically through a persistent
channel/profile conversation. `GET /deliveries` accepts `channelId`, `state`,
`after`, `limit`; `GET /deliveries/:id` exposes native identity and outcome.
`POST /deliveries/:id/cancel` takes an empty object and persists intent before
native abort. `GET /messaging/status` reports runner state. Queued messages are
not delivered prompts; completed native output produces one attributed reply.
Long output includes a bounded preview and native run link. Replies stop at
eight hops. Uncertain conversations wait for `/runs/:id/reconcile`; unrelated
conversations continue. Restart adopts existing runs rather than replaying them.

Run `MINDI_LIVE_ACCEPTANCE=1 pnpm --filter @mindi/backend acceptance:messages`
after building for real OMP DM delivery, restart deduplication and exact session
recall. Native agent messaging tools enforce run-bound identity and reply ancestry. Explicit
shared/nested channel branches retain durable fork receipts. Routine destinations
are snapshotted per occurrence and terminal publication is idempotent.

Automatic triage uses the same durable native attempt, capacity and recovery
mechanisms as coding. Planner profiles need kanban_get/list/create/update/prepare
grants. A successful planning attempt is review history; its parent returns to
todo, with child cards and dependencies retained. It never means implementation
was accepted. Explicit decomposition is allowed on manual boards; automatic
admission stops when the board switches to manual.

After building, run
`MINDI_LIVE_ACCEPTANCE=1 pnpm --filter @mindi/backend acceptance:triage`
for native planning, exact parent/child/dependency assertions and restart checks.

## Current service observations

Authenticated `GET /status` reports local process metrics, exact runtime activity,
retain-all capacity, and owned service observations. A completed dispatcher,
message runner, scheduler or publisher sweep is local evidence only; it does not
verify a provider login. Sweeps expire after 30 seconds, and faults or stopped
ownership withdraw readiness. Optional external services remain explicitly
unverified until their relevant acceptance path succeeds.

Container deployments may explicitly set `"host": "0.0.0.0"` in backend
configuration. The default remains `"127.0.0.1"`; other host values are rejected.
The operator token remains required on every route. Use host-loopback port
publication or an operator-owned HTTPS ingress for desktop connections.

Discord bindings may also set `dmRecipients`, mapping an existing DM channel ID
to its recipient user ID, for example `"dmRecipients": { "123": "456" }` with
real IDs. Use the channel ID in home/alias targets. A DM-only binding may omit
`guildId`; unconfigured channels then remain unavailable. Recipient changes need
a new binding revision. The backend verifies type 1 and the exact sole recipient
before sending or looking up receipts. It does not open DMs or accept DM threads.

## Voice from desktop and mobile

Enable GPT-Live on each box by adding `"voice": { "profileId": "mindi" }` to its backend configuration. The selected profile must already exist and must be the box's coordinator; an empty voice object defaults to `mindi`. Supply `OPENAI_API_KEY` to the backend process using an OpenAI project with `gpt-live-1` access. This key is separate from the OMP provider login and is never returned to either client. Omitting `voice` disables call creation.

Desktop has **Call Mindi** and **Open conversation** controls for the selected box. The latter opens the dedicated thread's history and existing approval/question controls, without a text composer or fork action. Mobile offers **Talk to Mindi** on the box home screen. Mobile requires a native development build; see [mobile voice setup](../mobile/VOICE.md).

One persistent voice-owned runtime thread is bound to the coordinator in this state directory. Each call starts a fresh GPT-Live session with the coordinator’s current effective SOUL/persona instructions and recent stored conversation context. Persona edits take effect on the next call. Desktop and mobile share this conversation; only one may call the box at a time. End the existing call before switching devices. Calls stop on client background/unmount. Hangup mutes immediately; it does not cancel coordinator tasks already running. Respond to requested permissions through the app's normal approval controls.

All voice endpoints require the existing bearer token:

| Method | Path                                 | Body / result                                          |
| ------ | ------------------------------------ | ------------------------------------------------------ |
| GET    | `/api/voice`                         | `{ enabled, active, threadId, profileId }`             |
| POST   | `/api/voice/calls`                   | `{ sdp, clientId }` -> 201 `{ callId, threadId, sdp }` |
| POST   | `/api/voice/calls/:callId/heartbeat` | `{ clientId }` -> `{ ok: true }`                       |
| DELETE | `/api/voice/calls/:callId`           | `{ clientId }` -> `{ ok: true }`                       |

`GET /api/voice` also returns public `activity` metadata: `state` (`idle`, `working`, `researching`, or `waiting`), `pendingInteractions`, and `runId`. It is scoped to the dedicated voice thread. Research means an outstanding desktop tool; waiting means pending human input. It contains no transcript, tool arguments, or private reasoning.

`GET /api/voice/transcripts?limit=100` returns the persisted spoken conversation as `{ items, nextBefore, nextAfter }`. Each fragment has a stable `sequence`, backend `callId`, `role`, `text`, and speech `start`/`end` offsets. Use either `before` for older history or `after` for new fragments; cursors are positive sequence numbers. Pages are capped at 100 fragments and 256 KiB including response metadata, so follow returned cursors rather than assuming a short page is complete. This authenticated feed contains spoken text only; coordinator work results and human decisions remain on the runtime routes.

Use a fresh client ID per attempt. A second caller gets 409. Never retry session creation automatically. Clients heartbeat every ten seconds; the backend requests closure after 45 seconds without a heartbeat. The backend exclusively owns the provider sideband, transcript persistence, delegation and result forwarding. Speech and coordinator work have separate lifecycles; late results cannot be spoken into a replacement call. Voice thread identifiers and the `voice:` creation namespace cannot be used for ordinary text turns/forks.

State lives in `voice.sqlite` beside `backend.sqlite`: transcript fragments with timestamps, delegation/run identities, the call reservation and final usage observation. Recent context is bounded when supplied to the models; persisted history is retained. Source transcripts may contain mistakes and overlapping speech. Duplicate IDs and repeated delegations without fresh input do not start additional turns. Existing coordinator tools, model, Hindsight memory and permission policy remain authoritative.

### Recovering uncertain finalization

A socket close is not proof that OpenAI finalized a paid session. The backend retains an uncertain call reservation and attempts to attach and close it, including after a backend restart. Definite provider creation rejection releases the reservation. An ambiguous create response without a session ID cannot be reconciled automatically.

If the box remains busy, first establish that the provider session has ended, then stop the backend and explicitly acknowledge that fact:

```sh
node apps/backend/dist/voice-recovery.js /absolute/path/to/state --confirm-provider-stopped 'Confirmed provider session ended'
```

The command refuses to run while the backend holds its application lock. It records the acknowledgement and removes only the active reservation, preserving the coordinator thread and transcripts. Restart the backend afterward. Do not clear a reservation merely because the client disconnected.

Contract sources: [GPT-Live](https://developers.openai.com/api/docs/guides/live), [client delegation](https://developers.openai.com/api/docs/guides/live-delegation), [WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc), [server controls](https://developers.openai.com/api/docs/guides/voice-server-controls), and [session lifecycle](https://developers.openai.com/api/docs/guides/live-conversations).

## Pi human/team coordinator

Enable the embedded Pi harness for the main Mindi profile with:

```json
{
  "coordinator": { "profileId": "mindi" },
  "voice": { "profileId": "mindi" }
}
```

Both objects default their profile ID to `mindi`. With `coordinator` enabled, voice must select the same profile. All turns for that profile use Pi, including desktop/mobile text, voice, task notifications and agent messages. Other profiles continue using OMP. Omitting `coordinator` preserves existing OMP configuration; switching a deployed box requires changing its operator-owned configuration.

Give the coordinator a focused persona and only coordination tools, for example:

```json
{
  "id": "mindi",
  "instructionsFile": "./MINDI.md",
  "modelIds": ["anthropic/claude-sonnet-4-6"],
  "defaultModelId": "anthropic/claude-sonnet-4-6",
  "approvalMode": "write",
  "tools": [
    "kanban_boards",
    "kanban_list",
    "kanban_get",
    "kanban_create",
    "kanban_update",
    "kanban_prepare",
    "kanban_comment",
    "dm_open",
    "dm_list",
    "dm_send",
    "channel_post",
    "ask_user",
    "history_read",
    "hindsight_recall",
    "hindsight_retain"
  ],
  "memory": { "url": "http://127.0.0.1:18888", "bankId": "mindi" }
}
```

Use an exact model ID supported by the pinned Pi catalog and credentials for that provider in the backend environment (for the example, `ANTHROPIC_API_KEY`). For subscription access, use an `openai-codex/<model>` ID and the [coordinator device login](../../packages/coordinator/README.md#openai-subscription-login). That path requires no provider API key. Pi stores and refreshes its own subscription login; it does not copy OMP/Codex credentials or silently substitute models. The speech model still uses its separate OpenAI project `OPENAI_API_KEY`. Choose and measure the coordinator model independently from the speech model; no latency improvement from a particular model is claimed here.

For basic browser research on her box desktop, explicitly grant `desktop_capture`, `window_capture`, `desktop_input`, and `window_input` and configure her profile desktop. Captures provide images and observation identifiers; input is bound to the current observation. Mindi has no shell or file-editing tools and is instructed to delegate coding and code review. She creates/prepares tasks for specialist profiles and gets durable references immediately. Board `dispatchMode: "auto"` admits prepared tasks automatically; manual boards retain operator dispatch. Tool approvals and questions appear through the existing desktop/mobile interaction UI. `write` asks before mutations; `always-ask` also asks before reads; `yolo` remains explicit operator policy.

Successful coordinator task creation/preparation subscribes its originating conversation to actionable task state changes. Blocked, review, done, archived and attention-required states produce idempotent coordinator turns when that conversation is idle. They do not restart specialist work. Notifications and their task revision cursors survive restart. Review remains distinct from completion. During an active voice call, the resulting public answer is appended only if the same call and user-input revision remain current. Disconnected calls do not receive late results.

Public voice response fragments stream before the coordinator run completes, with an overall bounded response budget. Interrupting speech invalidates later fragments; hanging up does not cancel a durable team task.

Sessions live under `stateRoot/pi-coordinator`; full original history persists independently from bounded model context. [Coordinator package documentation](../../packages/coordinator/README.md) describes SnapCompact, its Bun/native requirement, exact-history retrieval and fallback behavior. Hindsight remains the memory service.

An existing unbranched OMP coordinator conversation imports its public backend history once into a separate Pi journal on its next turn. Original OMP history is untouched; imported tool outcomes are historical evidence, never replay instructions. Missing Pi checkpoints fail explicitly. Legacy OMP forks require explicit history migration and are rejected rather than silently losing inherited context; new Pi conversations support native durable forks. The dedicated voice conversation retains its thread ID across this migration.

Coordinator notification recovery uses the same operator bearer authentication:

- `GET /coordinator/updates` lists the first 100 reports needing attention, including their task, conversation and failed run identities.
- `POST /coordinator/updates/retry` accepts `{ "taskId": "…", "threadId": "…", "expectedRunId": "…", "idempotencyKey": "…" }`. Use the listed run ID (or `null` for a report never admitted), and reuse the retry key if the HTTP response is uncertain. Active/unreconciled execution and stale identities are rejected. A completed report with failed channel publication retries publication only; a failed report gets a new reporting attempt. Neither path replays the original task mutation or restarts its specialist.

Failed reports are also reflected in the coordinator update component's health. These recovery endpoints are operator administration APIs; no new recovery UI is added to either app.
