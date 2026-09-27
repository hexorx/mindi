# Hermes desktop

One linux/amd64 container, one persistent root/default Hermes profile, and an s6-supervised headless Sway desktop. The official Hermes installation remains sealed at `/opt/hermes`; run it as uid 1000 via `docker exec --user 1000:1000 <container> /opt/hermes/.venv/bin/hermes ...`. Model calls need separately provisioned model credentials; boot and the computer-use smoke need none. There is no autonomous inference loop in this phase. Gateway integration, embedded memory and optional networking are separate work. Optional settings/personality sources are described in [CONFIG-SOURCES.md](CONFIG-SOURCES.md).

## Run

From the repository root, provide three operator-owned files outside the checkout: a random desktop password (16–256 bytes, one line), a TLS certificate valid for the hostname used, and its private key. Set `DESKTOP_PASSWORD_FILE`, `DESKTOP_TLS_CERT_FILE`, and `DESKTOP_TLS_KEY_FILE` to their absolute paths. Then:

```sh
docker compose -f stacks/agent-box-hermes/compose.yaml up --build
```

Open `https://localhost:8443/vnc.html` with a certificate trusted by your browser. The username is `desktop`; use the supplied password. Connect to the same origin and `/websockify` path. HTTPS, static assets and WebSocket upgrades all require authentication. The Compose port is bound only to host loopback. A reverse proxy must preserve the original Host/Origin and WebSocket headers. Do not publish raw ports 5900 or 6080. No GitHub account, Infisical, Buzz, SSH daemon, sudo, Docker socket, privileged mode or Tailscale is needed.

The supervisor starts as root solely to prepare ephemeral secret files and volume ownership. All desktop services run as uid/gid 1000. One named `/home/agent` volume holds configuration and sessions. Do not mount an existing multi-profile home: startup rejects extra profiles and unmanaged symlinked configuration. This phase owns `~/.hermes/config.yaml` as structured JSON (valid YAML), preserving existing JSON keys and enabling `computer_use.grant_existing_profile` for this dedicated desktop. The optional config resolver owns atomic profile snapshots; use its local mount or explicit remote refresh to change settings. The image removes upstream automatic per-profile reconciliation and dashboard services; human viewing uses authenticated noVNC.

Desktop access authorizes control of the box's dedicated session. Inject only box-specific credentials. Password hashes and TLS keys are copied into private `/run/user/1000` storage at boot and never baked into image layers. Restart to rotate files. Avoid overriding the fixed runtime home, profile, UID or Wayland environment. Wayland uses pixman with no GPU or host display access. Press Super+Enter for a terminal.

## Verification

```sh
python3 -m pip install PyYAML==6.0.3
pnpm build && pnpm lint && pnpm typecheck && pnpm test
docker buildx build --platform linux/amd64 --load -t hermes-desktop:smoke -f apps/agent-box-hermes/Dockerfile .
apps/agent-box-hermes/test/container-smoke.sh hermes-desktop:smoke
```

The container job builds cleanly without model/account secrets, checks unauthenticated HTTP/WebSocket denial and authenticated upgrade, rejects cross-origin requests, calls the actual Hermes `computer_use` handler with the real cua backend for capture/click/type, verifies typed text reaches a disposable GUI input sink, and sends SIGTERM with a 20-second shutdown deadline. No mocked backend or model inference is used. Unit tests cover private/idempotent configuration, preservation of settings, invalid shapes, symlinks, extra profiles and password handling. Docker must be available to claim the integration checks passed; local unit tests alone are insufficient.

## Provenance and rollback

Runtime adaptations derive only from the approved baseline `mindi-stack@b5ac82d`: Dockerfile, Sway, desktop s6 definitions, AT-SPI/wait helpers and the computer-use configuration requirement. New TLS/authentication/bootstrap/test code is authored here. See `docs/extraction-provenance.md` and the root MIT LICENSE. No compiled plugin bundle or excluded service is imported. Distro wayvnc is used unchanged because its loopback RFB stream is protected at the HTTPS proxy; the historical weak-RFB compatibility patch is unnecessary. Debian package licenses remain in the image. cua-driver 0.30.1 is pinned by release-asset SHA256; Hermes is pinned by the approved image digest. Apt packages remain distribution-resolved; complete SBOM/license reconciliation and release reproducibility belong to P9.

This PR does not authorize production deployment. Opi's eventual rollout should use an approved immutable image digest and a fresh canary volume, then run the same smoke. Rollback stops the canary and restores the previous image/configuration; preserve the home volume. No shared database migrations or destructive volume cleanup are part of this change.
