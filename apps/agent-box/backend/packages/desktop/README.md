# @mindi/desktop

Owns profile desktop process lifecycles and per-display input authority. The
package contains no Hermes configuration reader or dashboard authentication.
Application services must bind these internal interfaces to authenticated owners
and the current live profile generation; they are not public HTTP handlers.

`ProfileDesktopManager` serializes desired profile changes and owns only sessions
it launches. Its public status excludes runtime paths. It publishes a private
readiness record after startup and withdraws readiness before stopping processes.
`launchWaylandDesktop` starts private D-Bus, headless Sway and wayvnc processes with
parent-death signals. Owned wayvnc loads a private `enable_auth=false` config so
viewers get RFB type `1` without inheriting the shared Tailscale `:5900` auth file.
Every profile has a distinct runtime directory and configured Chrome data path.
The native test does not launch Chrome or verify persisted browser state.

`DesktopDriver` owns correlated MCP stdio requests. Tool errors and malformed
responses reject with sanitized errors. `DesktopInputBroker` requires a successful
capture before agent input, binds observations to owner and target, and invalidates
them after mutation or human takeover. Human leases acquire, drain, hold, release
and expire. Uncertain driver calls retain their permit; timeout or caller
cancellation must never be treated as proof that an input action stopped.

The target adapter follows the tested Cua 0.23.2 contract. Desktop mutations use
canonical `target` without legacy `scope`, `pid` or `window_id`. Window actions
require explicit window identity. Unknown tool names and target fields are rejected.
Primary-output desktop capture is the supported scope.

`disconnect()` and `waitForExit()` close the MCP child connection; they do not
prove that a detached Cua daemon stopped. The application must own the entire
profile generation before recovering uncertain input. Same-UID process separation
is operational routing, not a security sandbox against hostile local processes.

After building, native lifecycle/Cua acceptance can run in a disposable Linux image:

```sh
MINDI_PROFILE_RUNTIME_IMAGE=mindi/agent-box:phase3 pnpm exec vitest run tests/profile-desktop-native.test.ts
```

The test mounts only compiled package code read-only and disables container network.
It verifies two actual displays, distinct captures, control ownership and generation
replacement without affecting the peer. A backend/OMP integration test and enforced
view-only VNC transport remain required before advertising app desktop support.
