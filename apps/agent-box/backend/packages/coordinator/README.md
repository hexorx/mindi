# Embedded Pi coordinator

`PiCoordinatorWorker` implements `AgentWorker` with the published
`@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` 0.85.1 libraries.
The Agent loop, provider streaming, approval interactions and tool execution run
inside the backend process. It exposes coordination tools and explicitly granted
desktop research tools. Coding remains delegated to specialists.

```ts
new PiCoordinatorWorker({
  stateRoot,
  openAgentTools: ({ runId, profile, signal }) =>
    agentTools.open({
      runId,
      profileId: profile.id,
      tools: profile.tools ?? [],
      signal,
    }),
});
```

The optional `streamFn` and `resolveModel` options allow deterministic acceptance
with the actual Pi loop. API-key providers use Pi's built-in
environment credential resolution. OpenAI Codex uses the coordinator's private
subscription login, with Pi-owned token refresh. Model IDs are exact `provider/model` catalog
identities; an unsupported model fails explicitly. This package does not import
OMP or Claude credential files.

## Authority and persistence

`COORDINATOR_TOOLS` contains only the durable agent task/message tools, `ask_user`,
`history_read`, `attachment_read`, `hindsight_recall`, `hindsight_retain`, and the four native desktop
capture/input tools. Desktop tools require explicit profile grants and an
`openDesktopTools` per-run capability lease. Captures preserve image blocks and
observation identifiers; input requires a current observation. Leases close when
the run ends. Profile grants restrict the available tools.
`always-ask` gates all external tools, `write` gates mutations, and `yolo` skips
approval. Decisions use the supplied runtime `requestInteraction` callback;
missing or denied approval never executes the tool. `ask_user` uses the same
callback. Hindsight tools exist only with a configured persona memory bank and
call its native HTTP API; a local transcript is not treated as Hindsight memory.

Each thread has a deterministic engine-tagged JSON journal under
`stateRoot/pi-coordinator`. Every message completion is fsynced to a temporary
file and atomically renamed, followed by directory fsync before the loop continues. Model context projection
never replaces journal history. Same-thread turns are serialized. Forks copy
history before the selected user message and preserve the parent's bytes.
Interrupted tool intents receive an explicit unknown-outcome result on recovery;
no historical tool is automatically executed again.

Legacy sessions require `importLegacyHistory`. The backend must verify thread
ownership and the exact source session path before supplying public history.
Imports include source provenance and warnings against repeating historical
side effects. The source OMP file is untouched, and restarting before the runtime
has saved the new path does not duplicate the import.

## SnapCompact and context limits

The actual `@oh-my-pi/snapcompact` 18.1.19 package ships Bun source, Markdown text
imports and native rasterization. A bounded one-shot **Bun >= 1.3.14** process
renders old large tool output and older complete conversation turns into PNG frames for vision models. This renderer
has no tools, receives no provider credentials from this adapter, makes no provider calls, a ten-second timeout,
a four-frame cap and bounded output. Cancellation kills and reaps it. The native
package must support the deployment platform. Rendering is verified in the
coordinator context test with a real PNG signature.

A bounded 16-entry/16-MiB LRU cache keyed by source text and model avoids repeated
rasterization. Exact structured coordination fields remain text alongside frames,
including task IDs, approval state and completion contracts. Without vision,
Bun or the native renderer, structured tool outputs use a marked text projection;
unstructured outputs, human instructions and assistant commitments stay intact.
A conservative context budget fails explicitly before silently discarding those
commitments. The full original history remains on disk in either path. This is
context compression, not an alternative memory backend.

Provider connectivity and live Hindsight persistence require separate acceptance
with configured credentials and services; the deterministic tests do not claim
those external operations happened.

Conversation archiving requires the `history_read` profile grant (recommended for
persistent text and voice coordinators). It keeps at least eight recent messages
and cuts only at a user-turn boundary, preserving tool call/result pairs. Archive
notice text carries exact identifiers and commitment excerpts; it explicitly
requires exact history and current task state before relying on approvals.
`history_read` accepts only current-journal offsets, a limit of at most four
entries, and a character offset. Each serialized JSON message fragment is at
most 16,384 characters; `nextCharOffset` allows lossless reconstruction of large
entries. No path argument exists. Nonvision or renderer-unavailable conversations
remain text and require an explicit handoff if the safe budget is exhausted.

## OpenAI subscription login

Choose an exact `openai-codex/<model>` ID from the pinned Pi catalog for the
coordinator profile. No Anthropic or OpenAI API key is required for that provider.
Realtime speech remains a separate OpenAI API service requiring `OPENAI_API_KEY`.

Run the headless login as the backend's operating-system user, with the same
`stateRoot` used by the backend configuration:

```sh
node packages/coordinator/dist/login.js /absolute/backend/stateRoot login
```

Open the displayed device-login URL in your browser and enter the displayed code.
The command waits for authorization and reports when the login is saved. Device
code login must be available for your OpenAI account/workspace. `status` reports
only whether a subscription credential is stored, without refreshing or claiming
that the subscription currently has quota. `logout` removes only the coordinator
credential. Existing in-flight requests are not revoked by local logout.

For the deployed backend image:

```sh
docker exec -it -u hermes mindi-agent-box node   /opt/mindi-backend/node_modules/@mindi/coordinator/dist/login.js   /home/agent/.mindi/backend login
```

Credentials live in `stateRoot/coordinator-auth/openai-codex.json` (0600), inside
a private 0700 directory. Login and refresh use an interprocess lock, atomic file
replacement and fsync; each request reads current credentials so login/logout do
not require restarting the backend. Pi refreshes expiring tokens before use.
Failed refresh does not fall back to paid API usage. A stale lock from a crashed
writer is recoverable after two minutes; waiting operations support cancellation.
Do not remove a live lock manually. If the credential file is corrupt, run
`logout` then `login`; a new login alone cannot replace an unreadable record.

This store is independent of OMP and Codex CLI authentication. Sign in once for the
coordinator instead of copying their rotating refresh tokens. Keep this directory
on the box's persistent private volume and out of Git and client responses.

## Admitted attachments

Grant `attachment_read` to let the coordinator inspect large text or binary files. It accepts an attachment ID admitted to the current run or verified prior conversation history, a zero-based byte offset, and a length of 1–16,384 bytes. Each response contains exact base64, original filename/media type, size, SHA-256, and `nextOffset` (null at EOF). It accepts no path or URL and provides no general filesystem access. The tool follows the same approval policy as other reads. Responses are exact bytes, not a claim that a proprietary file format was interpreted.

Small valid UTF-8 text/JSON stays inline within the 192,000-byte aggregate prompt budget. Other non-image files remain available through the reader when granted; without the grant they fail explicitly. Images/PDF use the existing validated native image preparation. File snapshots cannot change during a read sequence. Later-turn historical access is not implemented by this reader.

`dm_send` and `channel_post` accept optional `attachmentIds` from the current run and an optional `branchId`. Channel forwards require an explicit agent recipient; DMs resolve their single peer. The backend verifies active source-run ownership and exact admitted metadata, then copies immutable bytes into the recipient channel/branch scope. File-only messages are supported. Original IDs do not grant the recipient access: the stored message carries new recipient-scoped IDs. Retries reuse content-bound staging and durable message receipts; a published replay works after the source run stops. Human approval follows the existing message tool policy. Later-turn files still need explicit persisted admission before they can be forwarded.

Historical reads resolve lazily through the runtime rather than trusting journal text. Use `history_read` to locate earlier attachment IDs; the runtime independently checks persisted completed admissions and exact branch ancestry. The same historical admission applies to specialist forwarding. No old file is automatically appended to every prompt, and unknown branch checkpoints cannot authorize parent files.
