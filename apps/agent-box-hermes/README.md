# Hermes desktop

One linux/amd64 container, one persistent root/default Hermes profile, and an s6-supervised headless Sway desktop. The official Hermes installation remains sealed at `/opt/hermes`; run it as uid 1000 via `docker exec --user 1000:1000 <container> /opt/hermes/.venv/bin/hermes ...`. Model calls use existing Codex subscription OAuth; no provider API key is required. Boot and the computer-use smoke need no subscription credentials. There is no autonomous inference loop in this phase. The release includes the Hermes API and built-in persistent file memory; optional networking remains separate. Optional settings/personality sources are described in [CONFIG-SOURCES.md](CONFIG-SOURCES.md).

## Run

From the repository root, provide three operator-owned files outside the checkout: a random desktop password (16–256 bytes, one line), a TLS certificate valid for the hostname used, and its private key. Set `DESKTOP_PASSWORD_FILE`, `DESKTOP_TLS_CERT_FILE`, and `DESKTOP_TLS_KEY_FILE` to their absolute paths. Also supply `API_SERVER_KEY`, `PAPERCLIP_CALLBACK_KEY`, and `PAPERCLIP_API_URL` in the runtime environment (see [P7.md](P7.md)). Then:

```sh
docker compose -f stacks/agent-box-hermes/compose.yaml up --build
```

Open `https://localhost:8443/vnc.html` with a certificate trusted by your browser. The username is `desktop`; use the supplied password. Connect to the same origin and `/websockify` path. HTTPS, static assets and WebSocket upgrades all require authentication. The Compose port is bound only to host loopback. A reverse proxy must preserve the original Host/Origin and WebSocket headers. Do not publish raw ports 5900 or 6080. No GitHub account, Infisical, Buzz, SSH daemon, sudo, Docker socket, privileged mode or Tailscale is needed.

The supervisor starts as root solely to prepare ephemeral secret files and volume ownership. All desktop services run as uid/gid 1000. One named `/home/agent` volume holds configuration and sessions. Do not mount an existing multi-profile home: startup rejects extra profiles and unmanaged symlinked configuration. This phase owns `~/.hermes/config.yaml` as structured JSON (valid YAML), preserving existing JSON keys and enabling `computer_use.grant_existing_profile` for this dedicated desktop. The optional config resolver owns atomic profile snapshots; use its local mount or explicit remote refresh to change settings. The image removes upstream automatic per-profile reconciliation and dashboard services; human viewing uses authenticated noVNC.

Desktop access authorizes control of the box's dedicated session. Inject only box-specific credentials. Password hashes and TLS keys are copied into private `/run/user/1000` storage at boot and never baked into image layers. Restart to rotate files. Avoid overriding the fixed runtime home, profile, UID or Wayland environment. Wayland uses pixman with no GPU or host display access. Press Super+Enter for a terminal.

## Optional userspace Tailscale (P6)

Off by default. With `AGENT_BOX_TAILSCALE` unset, `0` or `false`, no daemon starts and `/run/agent-box/network.json` reports `disabled/disabled`; ordinary Docker networking and the loopback-published desktop work unchanged. This is the mode for CI and hosts without a tailnet.

To enable, add the overlay and a runtime key file:

```sh
TAILSCALE_AUTHKEY_FILE=/abs/path/authkey AGENT_BOX_TAILSCALE_HOSTNAME=helper-box \
  docker compose -f stacks/agent-box-hermes/compose.yaml -f stacks/agent-box-hermes/compose.tailscale.yaml up -d
```

- **No TUN or capabilities.** `tailscaled --tun=userspace-networking` runs under s6 as its own longrun. It needs no `/dev/net/tun`, `NET_ADMIN`, host network or privileged mode. If it exits, s6 restarts only this service; desktop and memory keep running.
- **Independent identity.** Node state lives in the `box-tailscale` volume at `/var/lib/tailscale`, root-owned (0700) and separate from `/home/agent`. Startup refuses to enroll unless that path is its own mount, so identity cannot silently vanish on recreation. Never copy this volume to another box.
- **Enrollment.** Use a single-use, tagged, non-ephemeral key (for example `tag:agent-box`). The key is passed to `tailscale up` as `--auth-key=file:<path>`, never through argv, environment or logs. It is only read while the node is logged out, and each distinct key is tried once. After enrollment, replace the file with an empty one or remove the secret. Restarts reuse the persisted identity without it.
- **Revocation and re-enrollment.** If an admin expires or removes the node, health reports `not_ready/not_enrolled` and the desktop stays up. Supplying a new key file re-enrolls without restarting the container. A rejected key reports `not_ready/unauthorized`.
- **Locked preferences.** Every enrollment and start forces `--ssh=false --webclient=false --advertise-exit-node=false --advertise-routes= --accept-routes=false --accept-dns=false`. `up --reset` clears any operator user, so the uid 1000 agent gets read-only LocalAPI access and cannot enable SSH, Serve or Funnel.
- **Private Serve only.** The only published endpoint is `https:443 -> https+insecure://127.0.0.1:8443`, the authenticated desktop origin. On every start, and if drift is detected, any other Serve or Funnel config is reset. Funnel is never enabled. If the tailnet lacks HTTPS certificates, Serve is withdrawn, health reports `degraded/unavailable`, and it retries every 5 minutes.
- **Loopback rule.** Userspace Tailscale forwards inbound tailnet TCP to `127.0.0.1:<port>`. So raw VNC (5900), websockify (6080), Hindsight (8888), embedded pg0 Postgres and the egress proxies bind `127.0.0.2`, which tailnet peers cannot reach. **Any future loopback-only service (such as Hermes API) must bind `127.0.0.2`, or it will be tailnet-reachable when Tailscale is on.** Recommended tailnet policy still restricts `tag:agent-box` to `tcp:443` from approved sources.
- **Tailnet egress.** Userspace mode does not route application traffic. Callers that need tailnet-only URLs (for example a Paperclip callback, P7) use SOCKS5 `127.0.0.2:1055` or the HTTP proxy `127.0.0.2:1056`.
- **Health.** `/run/agent-box/network.json` holds a `{status, code}` object matching the `network` check in `@mindi/agent-box-core`. `isRegistrationReady` treats anything but `ready` as not ready when Tailscale is enabled. The Docker `HEALTHCHECK` stays desktop-only.

Mapping `network.tailscale` from a config source to `AGENT_BOX_TAILSCALE` is P5 work.

## Verification

```sh
python3 -m pip install -r apps/agent-box-hermes/requirements-test.txt
pnpm build && pnpm lint && pnpm typecheck && pnpm test
docker buildx build --platform linux/amd64 --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" --load -t hermes-desktop:smoke -f apps/agent-box-hermes/Dockerfile .
apps/agent-box-hermes/test/container-smoke.sh hermes-desktop:smoke
apps/agent-box-hermes/test/tailscale-smoke.sh hermes-desktop:smoke
```

Both Compose files also require `MINDI_SOURCE_REVISION`; set it to `git rev-parse HEAD` from the source checkout used for the build. Release builds must use a clean checkout. The final OCI revision label names this mindi commit, while the pinned Hermes base retains its separate upstream identity.

`tailscale-smoke.sh` runs the real `tailscaled` against a disposable, digest-pinned Headscale control server (no Tailscale account or secrets). It proves enrollment without TUN or added capabilities, locked preferences, a Serve config free of Funnel and TCP forwards, identical node ID after a restart with the key removed, `not_enrolled` after node expiry while the desktop stays healthy, and re-enrollment with a fresh key. A second tailnet node checks that it reaches the authenticated 8443 origin but not 5900, 6080 or the egress proxies. Headscale cannot issue Serve certificates, so HTTPS Serve itself is verified on a real tailnet during the P10 canary.

The container job builds cleanly without model/account secrets, checks unauthenticated HTTP/WebSocket denial and authenticated upgrade, rejects cross-origin requests, calls the actual Hermes `computer_use` handler with the real cua backend for capture/click/type, verifies typed text reaches a disposable GUI input sink, and sends SIGTERM with a 20-second shutdown deadline. No mocked backend or model inference is used. Unit tests cover private/idempotent configuration, preservation of settings, invalid shapes, symlinks, extra profiles and password handling. Docker must be available to claim the integration checks passed; local unit tests alone are insufficient.

## Provenance and rollback

Runtime adaptations derive only from the approved baseline `mindi-stack@b5ac82d`: Dockerfile, Sway, desktop s6 definitions, AT-SPI/wait helpers and the computer-use configuration requirement. New TLS/authentication/bootstrap/test code is authored here. See `docs/extraction-provenance.md` and the root MIT LICENSE. No compiled plugin bundle or excluded service is imported. Distro wayvnc is used unchanged because its loopback RFB stream is protected at the HTTPS proxy; the historical weak-RFB compatibility patch is unnecessary. Debian package licenses remain in the image. cua-driver 0.30.1 is pinned by release-asset SHA256; Hermes is pinned by the approved image digest. Apt packages remain distribution-resolved; complete SBOM/license reconciliation and release reproducibility belong to P9.

This PR does not authorize production deployment. Opi's eventual rollout should use an approved immutable image digest and a fresh canary volume, then run the same smoke. Rollback stops the canary and restores the previous image/configuration; preserve the home volume. No shared database migrations or destructive volume cleanup are part of this change.

## Subscription login

Start with a fresh home volume, then log in with the existing Codex subscription:

```sh
docker exec -it --user 1000:1000 BOX /opt/hermes/.venv/bin/hermes auth add openai-codex --type oauth --no-browser
docker exec -it --user 1000:1000 BOX /opt/hermes/.venv/bin/hermes chat --provider openai-codex
```

Complete the device login in your browser. OAuth state lives in the private
persistent `/home/agent/.hermes/auth.json`; do not put it in git, build arguments,
image layers, logs, or ticket attachments. `HERMES_INFERENCE_MODEL` selects a
subscription model at first boot (default `gpt-5.6-sol`). `openai-codex` is the
only bootstrap provider; paid API providers and custom endpoints are rejected.
There is no API-key fallback. An expired/revoked login requires logging in again.

Existing operator config is preserved: a home previously configured for a paid
provider must not be reused for this release without explicit operator migration.
Use a fresh home and retain the old home and Hindsight volumes for rollback.
Do not copy unrelated credentials from a shared agent home into the box.

## Persistent file memory (release limitation)

The simplified release uses Hermes built-in `MEMORY.md` / `USER.md` files under
`/home/agent/.hermes/memories`, and enables the memory tool. The same persistent
home stores sessions and OAuth state. No embedding model download, embedding
key, memory LLM key or database is needed. Container readiness covers the actual
desktop and Hermes API; Hindsight is dormant and is not a readiness dependency.

This is **not Hindsight semantic recall**. Historical Hindsight memories are not
migrated or automatically imported. Existing `/var/lib/agent-box/hindsight` data
and the legacy archive helpers are retained, untouched by the new entrypoint.
Back up the home while the container is stopped; keep previous image/config/home
and memory volumes together. Roll back by selecting the old image and its saved
volumes, without overwriting the new home or deleting the frozen image.

See [private release](../../docs/hermes-promotion.md) for the build, layer secret
scan and real subscription smoke. Opi owns publication and rollout.

## P7 qualification ingress

The P7 launcher supervises the compatibility API on loopback 8642 and the native
gateway on private loopback 8643. HTTPS ingress admits authenticated run,
health, approval and steer routes; alternate chat/job/profile inference routes
are denied. All admitted callers share one durable reservation journal and
desktop slot. See [protocol qualification](../../docs/hermes-protocol-compatibility.md)
for resource caps, restart behavior, offline tests and gated rollout notes.
