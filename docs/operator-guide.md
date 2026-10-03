# Agent box operator guide

How to run the published agent box, log in with a subscription, connect it to
Paperclip, and roll it out or back. It needs no GitHub account and no Tailscale.

## What is published

| Item | Value |
|---|---|
| Image | `ghcr.io/hexorx/agent-box-hermes` |
| First release | `sha-fb54b6e50d405520d20f419fea41a11136e2e515` |
| Digest | `sha256:f4c6a32ef74f88ab55b3696a28f29fc258d1b4932bd619cf338b6d44ea8c37f0` |
| Built from | `apps/agent-box` (the original backend box) by `.github/workflows/hermes-promote.yml` |
| Platform | linux/amd64 |

Always deploy by digest. Tags are immutable, but a digest is what you roll back to.

The image name says "hermes", but the image runs the **Mindi backend**
(`/opt/mindi-backend`, port 65005) under s6 with five configured personas. The
backend starts a Sway desktop for a persona only after that persona's desktop is
enabled through the authenticated desktop settings API or client; none runs by
default. The box does **not** start the Hermes gateway, the Hermes dashboard or
Hindsight.
Agent processes run as the `hermes` user, UID and GID 10000; `/init` starts
as root to prepare the persistent home and supervise services. The Hermes CLI, OMP and Claude Code are installed and
each keeps its own login in the home volume.

`apps/agent-box-hermes` is a separate, unpublished extraction that does run the
Hermes API on port 8443 (see [its README](../apps/agent-box-hermes/README.md)
and [P7 handoff](../apps/agent-box-hermes/P7.md)). Do not mix its compose files
or environment with the published image.

## Requirements

- Docker with Compose v2 on a linux/amd64 host.
- About 256 MiB of shared memory (`shm_size`, set by the compose file).
- A persistent named volume for `/home/agent`. It holds logins, backend state,
  sessions and file memory. Losing it means logging in again and losing history.
- Subscription accounts for the harnesses you plan to use: ChatGPT (Codex) for
  Hermes and OMP, and Claude for Claude Code. No model API key is used.

## Run it (no GitHub, no Tailscale)

This example uses only Docker networking and a loopback port. The GHCR package
is public, so `docker pull` needs no registry login. The example files come from
a clone of the public `hexorx/mindi` repository.

1. Create an operator directory outside any Git checkout and copy the example
   backend configuration into it:

   ```sh
   mkdir -p ~/agent-box && cd ~/agent-box
   cp -r <mindi checkout>/apps/agent-box/example ./example
   cp <mindi checkout>/apps/agent-box/compose.yaml ./compose.yaml
   ```

   `example/backend.json` defines the profiles (`mindi`, `codi`, `archi`, `qai`,
   `rai`), the model each uses, and binds the backend to `0.0.0.0:65005` inside
   the container. `example/SOUL.md` is the shared persona text. Edit both to suit.

2. Create the backend operator token. It must be at least 32 characters and
   readable by the box's `hermes` user (UID 10000). It authenticates clients to the backend; it is not a
   model key.

   ```sh
   umask 077
   openssl rand -hex 32 > ~/agent-box/backend-token
   sudo chown 10000:10000 ~/agent-box/backend-token
   ```

3. Start the box by digest:

   ```sh
   export AGENT_BOX_IMAGE=ghcr.io/hexorx/agent-box-hermes@sha256:f4c6a32ef74f88ab55b3696a28f29fc258d1b4932bd619cf338b6d44ea8c37f0
   export BACKEND_TOKEN_FILE="$HOME/agent-box/backend-token"
   export AGENT_BOX_PORT=65005
   docker compose up -d
   ```

   The compose file publishes only `127.0.0.1:${AGENT_BOX_PORT}` (default 65005),
   sets `HINDSIGHT_ENABLED=0` and `AGENT_BOX_RUN_DIR=/tmp/agent-box`, and mounts the token and example configuration read-only. Nothing in it
   references GitHub, Tailscale, Infisical or an API key. If the host already
   runs a box on 65005, Compose fails with `port is already allocated`; choose
   another `AGENT_BOX_PORT` and use it in the commands below.

4. Check health. Every endpoint, including `/health`, needs the token:

   ```sh
   curl -fsS -H "Authorization: Bearer $(cat "$BACKEND_TOKEN_FILE")" \
     "http://127.0.0.1:$AGENT_BOX_PORT/health"
   curl -fsS -H "Authorization: Bearer $(cat "$BACKEND_TOKEN_FILE")" \
     "http://127.0.0.1:$AGENT_BOX_PORT/profiles"
   ```

   The first call returns health and protocol version; the second lists the
   configured profiles. If the container exits, read `docker compose logs`; a
   missing or unreadable token or configuration file stops the backend at start;
   `Backend token file is not readable` in the logs means the token is not owned
   by UID 10000.

For remote access, keep the port on loopback and put an operator-owned HTTPS
reverse proxy (for example Dokploy/Traefik) in front of it. The native Mindi
client accepts HTTPS or loopback HTTP endpoints. Tailscale is optional and is
not part of this image's compose file.

## Log in with your subscription

Run login commands as the `hermes` user against the running container, from an
interactive terminal: each command prints a URL or code and waits for you to
finish in a browser. Logins are stored
in `/home/agent`, so they survive restarts and image upgrades as long as the
volume is kept. Never copy login files into a build context, image, Git or CI.

| Harness | Used for | Login |
|---|---|---|
| Hermes CLI | Hermes answers (`openai-codex`) | `docker compose exec --user hermes agent-box /opt/hermes/.venv/bin/hermes auth add openai-codex --type oauth --no-browser`, then finish the browser flow it prints |
| OMP | Backend conversations | `docker compose exec --user hermes agent-box omp`, then use its login |
| Claude Code | Claude ACP delegation | `docker compose exec --user hermes agent-box claude auth login` |

On first start, `/opt/subscription.py` writes `~/.hermes/config.yaml` for the
`openai-codex` provider if it does not already exist. Set
`HERMES_INFERENCE_MODEL` in the Compose service's `environment` before the
first start to choose the model (a host export alone is not forwarded); any other
provider or a custom base URL is refused. An existing `config.yaml` is never
overwritten.

The three logins are independent. Logging in to Hermes does not log in OMP or
Claude, so verify each path you rely on: a Hermes answer, a backend chat (create
a thread with `POST /threads` and start a run with `POST /threads/:id/runs`), and
a Claude delegation if a profile uses `delegate_claude`. A backend run with no
OMP login fails with `errorCode: unavailable` ("Worker did not complete"); log
in to OMP and retry.

## Configuration sources

The published box reads configuration only from what you mount:
`MINDI_BACKEND_CONFIG` (the backend JSON) and the SOUL files it names. Paths in
the JSON resolve relative to that file, and `stateRoot` must sit under
`/home/agent`. Managed personas created through `POST /profiles` are stored in
the home volume. The full schema is in
[`apps/agent-box/backend/apps/backend/README.md`](../apps/agent-box/backend/apps/backend/README.md).

The GitHub user/org/repo config-source conventions in
[`apps/agent-box-hermes/CONFIG-SOURCES.md`](../apps/agent-box-hermes/CONFIG-SOURCES.md)
apply to the unpublished `agent-box-hermes` flavor only. The published image does
not fetch remote configuration.

## Register in Paperclip

**The published image is not registered with Paperclip.** It does not start the
Hermes API server, and Paperclip has no adapter for the Mindi backend protocol
on port 65005. Use it for desktop and human work.

For Paperclip work, run a box built from `apps/agent-box-hermes` and register it
with the `hermes_gateway` adapter. This is the path accepted on the P7 test box
(agent `hermes-p7-test`). That box serves the Hermes API through HTTPS port 8443;
use `https://<private-box-name>:8443` as the endpoint. Build, runtime inputs and
rollback are in the [P7 handoff](../apps/agent-box-hermes/P7.md). There is no
published image for this flavor: build it from source on the deployment host.

Register it with the admin CLI:

```sh
pnpm install --frozen-lockfile
pnpm --filter @mindi/agent-box-admin... build
node packages/agent-box-admin/dist/cli.js register --request registration.json --dry-run
node packages/agent-box-admin/dist/cli.js register --request registration.json --state /operator/roster-state
node packages/agent-box-admin/dist/cli.js reconcile --request registration.json --state /operator/roster-state
```

The request is secret-free: the box credential is a Paperclip secret UUID
(`apiSecretId`) plus a symbolic reference bound through
`AGENT_BOX_CREDENTIAL_<ref>` in the operator's environment. Hires go through
Paperclip's approval-aware `agent-hires` endpoint; a pending approval is left
pending, never activated by a status change. After a timeout or an `uncertain`
result (exit code 2), run `reconcile` before trying `register` again.
A Hermes roster entry may omit `box.adapterType`; it resolves to
`hermes_gateway`. The full request format is in the
[admin README](../packages/agent-box-admin/README.md).

## Rollout checklist

- [ ] Record the current image digest, compose file and backend configuration.
- [ ] Back up the stored compose, environment and backend configuration, with
      checksums, to the operator backup location (for drone: vault).
- [ ] Back up the home volume, with the container stopped, if it holds state you
      cannot recreate.
- [ ] Confirm no secrets or API keys remain in the compose or environment that
      the new image does not need.
- [ ] Deploy the new digest to one box first, with the same home volume.
- [ ] Check `/health` and `/profiles` with the backend token.
- [ ] Log in, or confirm existing logins, for each harness you rely on, and get
      one real answer from each.
- [ ] Check the desktop for any persona whose desktop is enabled.
- [ ] Only then update the remaining boxes, one at a time.
- [ ] Record the deployed digest, configuration checksum and check results on the
      rollout ticket.

## Rollback checklist

- [ ] Pause anything that sends work to the box (Paperclip wakes, routines,
      connectors).
- [ ] Stop the failed container. Do not delete its volumes.
- [ ] Restore the previous image digest and the backed-up compose, environment
      and configuration.
- [ ] Start with the **same** home volume. If the failure corrupted state, stop
      the box and restore the home volume backup instead.
- [ ] Re-run the health, profile and login checks.
- [ ] Keep the failed digest, its volumes and all backups until recovery is
      confirmed. Deleting images, volumes or backups needs Josh's approval.

## Recovery notes

- **Lost login:** log in again with the commands above; the home volume keeps
  everything else.
- **Lost home volume:** restore its backup. Without one, the box starts clean and
  needs fresh logins; backend history and managed personas are gone.
- **Uncertain backend mutation:** reread `/profiles` or the thread before
  retrying; the backend does not guarantee a lost response was not applied.
- **Old Hindsight data:** this image does not start Hindsight. Keep any existing
  Hindsight volume untouched; it is not migrated or deleted.
