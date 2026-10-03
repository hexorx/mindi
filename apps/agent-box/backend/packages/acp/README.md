# @mindi/acp

Maintained ACP protocol version 1 client for owned stdio subprocesses, on Node
22.13 or later. Build with `pnpm --filter @mindi/acp build`.

`AcpClient.connect(options)` launches and negotiates the agent. Options contain
`command`, `args`, `cwd`, optional `env`, `timeoutMs` (150 seconds by default),
`maxFrameBytes` (1 MiB by default), `onText`, and `requestPermission`.

- `newSession({cwd, mcpServers: []})` returns `{sessionId}`.
- `prompt({sessionId, text, signal?})` returns `{text, stopReason}` only after a
  correlated `end_turn` response with nonempty streamed text. Other stop reasons,
  an acknowledgment without completion, process errors, and empty output reject.
- One prompt per session may be active. Stream text is session scoped internally;
  the optional `onText(text)` callback reports chunks across all sessions.
- Permission callbacks receive validated session, tool-call ID, and offered
  option fields. Only an offered option ID can be selected; absent or unrecognized
  choices cancel. Requests without an active prompt and choices returned after that
  prompt is cancelled or finishes also cancel. Client filesystem and terminal
  requests receive method-not-found.
- Incoming frames and each prompt's accumulated text are bounded by
  `maxFrameBytes`. Stderr is drained without retaining potentially sensitive output.
- Abort sends `session/cancel`. After a 250 ms grace period the client closes if
  the agent has not responded. Request timeouts also send cancellation before
  closing. These failures can close other sessions on the same owned process.
- `close()` ends stdin, then forcibly stops the owned process after 250 ms. On
  POSIX, a dedicated process group includes launcher descendants. Windows only
  guarantees termination of the directly spawned process.

`nativeClaudeLaunch({cwd, env?})` returns an `npx --yes
@agentclientprotocol/claude-agent-acp@0.75.1` launch configuration. It strips
Anthropic and Claude Code environment overrides and the Bedrock bearer token.
It reads or copies no credentials; native Claude login must already be available.

Integration tests launch an external fixture process. They do not call a real
model or verify Claude login, package installation, or live adapter compatibility.

`ConnectOptions.signal` cancels initialization or the connection's active
sessions, sending `session/cancel` before stdin closes. The optional
`processGroup: "inherit"` is for a trusted supervisor that already owns a
dedicated group: ACP bounds direct-child cleanup while that supervisor owns
descendant cleanup. Standalone connections default to isolated process groups.

For packaged hosts, trusted `MINDI_CLAUDE_ACP_COMMAND` selects an installed
adapter executable directly, with no arguments or shell evaluation. Without
that setting the pinned npx launch remains the default. Provider override
filtering is applied in both cases. OMP forwards this setting only to profiles
with Claude delegation enabled.
