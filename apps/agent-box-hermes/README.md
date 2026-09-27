# Hermes desktop (P3)

One linux/amd64 container, one persistent root/default Hermes profile, and an s6-supervised headless Sway desktop. The official Hermes installation remains sealed at `/opt/hermes`; run it as uid 1000 via `docker exec --user 1000:1000 <container> /opt/hermes/.venv/bin/hermes ...`. Model calls need separately provisioned model credentials; boot and the computer-use smoke need none. There is no autonomous inference loop in this phase. Gateway integration, embedded memory, remote config and optional networking are separate P4–P7 work.

## Run

From the repository root, provide three operator-owned files outside the checkout: a random desktop password (16–256 bytes, one line), a TLS certificate valid for the hostname used, and its private key. Set `DESKTOP_PASSWORD_FILE`, `DESKTOP_TLS_CERT_FILE`, and `DESKTOP_TLS_KEY_FILE` to their absolute paths. Then:

```sh
docker compose -f stacks/agent-box-hermes/compose.yaml up --build
```

Open `https://localhost:8443/vnc.html` with a certificate trusted by your browser. The username is `desktop`; use the supplied password. Connect to the same origin and `/websockify` path. HTTPS, static assets and WebSocket upgrades all require authentication. The Compose port is bound only to host loopback. A reverse proxy must preserve the original Host/Origin and WebSocket headers. Do not publish raw ports 5900 or 6080. No GitHub account, Infisical, Buzz, SSH daemon, sudo, Docker socket, privileged mode or Tailscale is needed.

The supervisor starts as root solely to prepare ephemeral secret files and volume ownership. All desktop services run as uid/gid 1000. One named `/home/agent` volume holds configuration and sessions. Do not mount an existing multi-profile home: startup rejects extra profiles and symlinked configuration. This phase owns `~/.hermes/config.yaml` as structured JSON (valid YAML), preserving existing JSON keys and enabling `computer_use.grant_existing_profile` for this dedicated desktop. Arbitrary YAML and remote personalization are deferred to P5. The image removes upstream automatic per-profile reconciliation and dashboard services; human viewing uses authenticated noVNC.

Desktop access authorizes control of the box's dedicated session. Inject only box-specific credentials. Password hashes and TLS keys are copied into private `/run/user/1000` storage at boot and never baked into image layers. Restart to rotate files. Avoid overriding the fixed runtime home, profile, UID or Wayland environment. Wayland uses pixman with no GPU or host display access. Press Super+Enter for a terminal.

## Verification

```sh
pnpm build && pnpm lint && pnpm typecheck && pnpm test
docker buildx build --platform linux/amd64 --load -t hermes-desktop:smoke -f apps/agent-box-hermes/Dockerfile .
apps/agent-box-hermes/test/container-smoke.sh hermes-desktop:smoke
```

The container job builds cleanly without model/account secrets, checks unauthenticated HTTP/WebSocket denial and authenticated upgrade, rejects cross-origin requests, calls the actual Hermes `computer_use` handler with the real cua backend for capture/click/type, verifies typed text reaches a disposable GUI input sink, and sends SIGTERM with a 20-second shutdown deadline. No mocked backend or model inference is used. Unit tests cover private/idempotent configuration, preservation of settings, invalid shapes, symlinks, extra profiles and password handling. Docker must be available to claim the integration checks passed; local unit tests alone are insufficient.

## Provenance and rollback

Runtime adaptations derive only from the approved baseline `mindi-stack@b5ac82d`: Dockerfile, Sway, desktop s6 definitions, AT-SPI/wait helpers and the computer-use configuration requirement. New TLS/authentication/bootstrap/test code is authored here. See `docs/extraction-provenance.md` and the root MIT LICENSE. No compiled plugin bundle or excluded service is imported. Distro wayvnc is used unchanged because its loopback RFB stream is protected at the HTTPS proxy; the historical weak-RFB compatibility patch is unnecessary. Debian package licenses remain in the image. cua-driver 0.30.1 is pinned by release-asset SHA256; Hermes is pinned by the approved image digest. Apt packages remain distribution-resolved; complete SBOM/license reconciliation and release reproducibility belong to P9.

This PR does not authorize production deployment. Opi's eventual rollout should use an approved immutable image digest and a fresh canary volume, then run the same smoke. Rollback stops the canary and restores the previous image/configuration; preserve the home volume. No shared database migrations or destructive volume cleanup are part of this change.

## Embedded persistent memory

Hindsight `0.6.1` runs in `/opt/hindsight`, isolated from Hermes, with
`pg0-embedded==0.14.0`. It listens on **127.0.0.1:8888 only** and is not
published or proxied. Hermes uses `local_external`, so it does not launch a
second daemon. The container health check also requires Hindsight's database
health check to pass.

Mount runtime secret files `memory_llm_key` and `memory_embeddings_key` under
`/run/secrets` (Compose host variables: `MEMORY_LLM_KEY_FILE` and
`MEMORY_EMBEDDINGS_KEY_FILE`). Both are required, even when using the same
provider account. Bootstrap validates them and stages mode-0600 copies under
`/run/user/1000/memory`; only Hindsight receives their values in its process
environment. Missing keys produce a named, value-redacted diagnostic and fail
startup. Secret files are never written to either persistent volume.

Operator environment settings (set in the Compose service's `environment`):

| Setting | Default |
| --- | --- |
| `MEMORY_LLM_PROVIDER` | `openai` (also supports `anthropic`) |
| `MEMORY_LLM_MODEL` | `gpt-4o-mini`; Anthropic: `claude-sonnet-4-20250514` |
| `MEMORY_LLM_BASE_URL` | Provider default |
| `MEMORY_EMBEDDINGS_MODEL` | `text-embedding-3-small` |
| `MEMORY_EMBEDDINGS_BASE_URL` | OpenAI default; OpenAI-compatible endpoints supported |

The memory service alone sets `HOME=/var/lib/agent-box/hindsight`. Verified
against [pg0 v0.14.0 source](https://github.com/vectorize-io/pg0/blob/v0.14.0/src/main.rs):
its base is `$HOME/.pg0`, and the `hindsight` instance stores data in
`.pg0/instances/hindsight/data`. The dedicated `box-memory` volume therefore
contains database data, installation and instance metadata. No guessed pg0
environment setting or symlink into the profile is used.

`/home/agent/.agent-box/identity.json` persists the stable UUID; the memory bank
is `box-<UUID>`. The memory volume records its box binding and rejects reuse
with a different home identity. Keep home and memory volumes together during
recovery. A new box needs new volumes; copying a box is a separate operation.

## Offline backup and restore

Opi owns production operations. Stop new work, then stop the entire container
cleanly; a live data-directory copy is not a backup. Back up the matching home
volume separately using the operator's existing offline volume procedure.
The helper refuses running or uncleanly stopped containers and refuses to
replace an existing archive or restore into a nonempty destination:

```sh
docker stop --time 20 BOX
apps/agent-box-hermes/scripts/memory-volume.sh backup BOX memory.tar.gz
docker volume create memory-restored
apps/agent-box-hermes/scripts/memory-volume.sh restore BOX memory.tar.gz memory-restored
```

Recreate the box with its matching home volume and `memory-restored`, the same
image digest, and fresh runtime secret mounts. Verify health and recall before
resuming work. Treat archives as private agent data. Before an upgrade, retain
the old image digest and both volume snapshots. Roll back to that digest with
matching pre-upgrade snapshots if database migrations prevent downgrade;
never run an older image against an unverified newer database schema.

Container CI performs actual Hindsight retain/recall and checks the pg0 data
path, bank isolation and loopback listeners across restart, container
recreation, and restore to a new volume. Only the OpenAI-compatible inference
HTTP service is a deterministic test fixture; no paid inference is used. A
production-provider inference check remains part of the approved canary.
