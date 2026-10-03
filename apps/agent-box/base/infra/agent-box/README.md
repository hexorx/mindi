# Agent box image

Wayland desktop for one GitHub-identity tenant, layered on the official
`nousresearch/hermes-agent` image. Build from the **repo root**:

```sh
docker build -t mindi/agent-box:latest -f infra/agent-box/Dockerfile .
```

Pin the Hermes tag in the Dockerfile `HERMES_IMAGE` ARG (currently
`v2026.8.18`). Official s6-overlay stays PID 1; this image wraps
`entrypoint-dispatch.sh` after `bootfetch.sh`.

Contains Sway (headless), wayvnc (built from source on Debian 13), noVNC,
Google Chrome, sshd, herdr, baked-in `buzz` and `cua-driver` CLIs, AT-SPI,
XWayland (Hermes `computer_use` capture bridge), Hindsight (`/opt/hindsight`),
the `mindi-box` dashboard plugin, and first-boot identity (chezmoi + persona).
Hermes itself is the sealed `/opt/hermes` tree from the upstream image. omp
comes from the tenant dotfiles via mise.

The runtime Unix user is `hermes` remapped to uid 1000 (`HERMES_UID`).
Desktop home stays `/home/agent`; Hermes state is `$HERMES_HOME`
(`/home/agent/.hermes`). SSH `agent` is a same-uid login alias created at boot.

s6 longruns: dbus → at-spi → sway → wayvnc → websockify → sshd → herdr →
identity-watch → buzz-presence → hindsight → hermes-dashboard. The coordinator
gateway is an s6 profile slot (`hermes -p $PERSONA_NAME gateway start`), not a
second `gateway run`. Do not set `HERMES_DASHBOARD=1`.
