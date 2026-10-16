# @mindi/omp

Typed native OMP RPC adapter implementing `AgentWorker`. Requires Node 22.13+;
the protocol targets OMP 18.1.13 and negotiates protocol version 2.

`new OmpWorker({cwd, stateRoot, command?, args?, env?, timeoutMs?, maxFrameBytes?})`
uses a trusted fixed executable (default `omp`) and trusted workspace.
It exposes `run`, `fork`, and `branchPoints` using runtime types.

- Persona instructions and the explicitly allowed `provider/model` selection are
  applied to every turn. Automatic OMP retries are disabled.
- Persona `tools` is the trusted tool allowlist. Missing/empty means no tools.
  `approvalMode` defaults to `always-ask` (automatic reads, prompts before writes
  and execution); `write` automatically permits reads/writes, and `yolo` permits
  all enabled tiers. Native tool-owned restrictions still apply. The private
  configuration resets inherited per-tool overrides with `tools.approval: null`.
  This reset relies on pinned OMP 18.1.13 merge/wrapper behavior. It is not an OS
  sandbox: enabled coding tools act in the configured trusted workspace.
- Extension, skill, rule, LSP and title discovery are disabled. Unexpected native
  tool events fail the turn. Native confirm/select/input/editor requests bridge
  to `WorkerInput.requestInteraction`; absent callbacks and custom UI are
  cancelled. Native cancellation aborts its corresponding host request.
- Hindsight is off unless the persona has memory configuration. Inherited
  Hindsight environment routing and tokens are stripped. An enabled persona
  sets its own native bank URL/ID and enables native auto recall. After completion,
  the worker awaits native `/memory enqueue` with `agentInvoked:false` before
  closing; auto retain is disabled to avoid duplicate submissions. This barrier
  acknowledges native enqueue, not successful retention or future recall. Provider
  credentials remain in OMP's native harness; this package does not copy them.
- Session references must resolve to existing JSONL files beneath
  `stateRoot/sessions`. Native branching validates the selected branch entry and
  requires a different resulting session file.
- Prompt ACK is not completion. A successful turn requires a final assistant
  `stop` message with text and the true `agent_end`; intermediate `toolUse`
  messages continue. Error, abort, empty and malformed completion fail.
- Frames, reassembled chunks and per-turn text are bounded (1 MiB default).
  Stderr is drained. An optional `onDiagnostic(text)` operator callback receives
  a redacted tail bounded to 4 KiB; no diagnostics enter public run errors.
- Cancellation sends native `abort`; timeout does likewise and never retries.
  Shutdown ends stdin, then force-kills after 250 ms. POSIX uses a dedicated
  process group including ignored-stdio descendants. Windows covers the direct
  process only. Runtime errors distinguish invalid input, unavailable worker,
  timeout and cancellation.

The fixture tests launch external subprocesses and exercise native wire shapes.
They do not count as live provider, memory-service or login acceptance.

Protocol reference: [official OMP v18.1.13 RPC types](https://github.com/can1357/oh-my-pi/blob/v18.1.13/packages/coding-agent/src/modes/rpc/rpc-types.ts).

Enable native Claude delegation with trusted worker option
`claude: {permissionKinds: []}` and persona `tools: ["delegate_claude"]`.
The explicit extension uses the pinned native ACP adapter and existing native
login. Empty policy denies child tools; an allowed ACP tool-call kind can select
only an offered `allow_once`. Set `interactivePermissions: true` to ask the host
for each child permission instead; only offered one-time allow/reject options
are displayed. A failed child fails the parent run.

Transcripts are bounded to 2 MiB each beneath `stateRoot/transcripts`, with
versioned JSONL records carrying trusted `runId`, `threadId`, text and terminal
status. Operator inspection is read-only: `tail -f /absolute/state/transcripts/ID.jsonl`.
The extension uses ACP's inherited process-group mode under OMP's dedicated
group, so normal/cancelled worker cleanup includes the nested adapter tree.
Backend crash recovery remains the runtime's conservative ownership policy.

The extension entry is `@mindi/omp/claude-extension`; native OMP loads its compiled
default export automatically when the explicit persona tool and worker policy
are enabled. Its factory export `createClaudeExtension` supports trusted test
hosts. Model arguments contain only the delegated prompt.

Enable `ask_user` in persona tools for RPC-compatible clarification. The explicit
question extension accepts a question and optional choices and uses native OMP
UI requests. It cancels on missing UI, timeout or abort; invalid/unoffered answers
fail. This avoids the built-in `ask` tool, which the tested OMP RPC launch does
not expose. Interactive records and decision persistence belong to the runtime,
not this process adapter.

Run `MINDI_LIVE_ACCEPTANCE=1 pnpm --filter @mindi/omp acceptance:approvals`
after building to verify native approval, denial and automatic-write effects in
private temporary directories, including an inherited project `write: allow`.
The runner uses native model authentication and prints its evidence directory.

Task-context runs add the explicit `task_result` extension without changing the
persona's ordinary tool allowlist. The read-tier tool reports bounded structured
`review`/`blocked` details. The adapter matches native tool start/end IDs, rejects
malformed/duplicate/failed reports, and emits a typed task outcome. Assistant
prose is never interpreted as completion. The runtime and TaskRunner still require
terminal native completion; human review owns done. `task_result` is reserved for
host task context and cannot be enabled through an ordinary profile tool list.
