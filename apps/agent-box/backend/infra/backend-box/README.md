# Replacement backend image

Build the desktop base from `infra/agent-box/Dockerfile`, then package the
replacement backend from the repository root:

```sh
docker build -t mindi/agent-box:backend-base -f infra/agent-box/Dockerfile .
docker build --build-arg AGENT_BOX_IMAGE=mindi/agent-box:backend-base \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t mindi/backend-box:local -f infra/backend-box/Dockerfile .
```

The second build compiles the TypeScript dependency graph and deploys its
production dependencies into `/opt/mindi-backend`. It replaces legacy product s6
services and init scripts with the backend and Hindsight services. `/init` remains PID 1;
Hermes bootstrap, gateways and dashboard are not launched. The existing product
compose configuration is not changed by building this target.

The build writes `/opt/mindi-backend/build-info.json` with the backend package
version and optional full lowercase Git SHA supplied by `SOURCE_REVISION`.
Use a clean checkout matching that revision when making a release claim. Omitting
the argument leaves the revision unknown; invalid nonempty values fail the build.
Authenticated `/status` reports this packaged metadata. The desktop labels it as
backend-reported, separately from the image originally selected for deployment.
This is not signed attestation of a registry image or validation of a mutable tag.
Missing or invalid package metadata produces no build claim, including local
source runs. Startup captures the metadata once; changing a file in a running
container does not change its status report.

Runtime files and executable permissions are assembled in the build stage and
copied together to keep the final image below overlay2's layer depth limit.
The public `google-chrome` launcher uses `/home/agent/.local/share/mindi-tools/chrome/opt/google/chrome/chrome` with
the incoming managed Wayland environment and container/accessibility flags.
It does not consult Hermes configuration. When `MINDI_CHROME_USER_DATA_DIR` is
set, it must be an absolute, non-empty path; the launcher injects that exact
directory and rejects caller `--user-data-dir` flags. The desktop runtime owns
creation and private-directory validation. With the variable unset, ordinary
Chrome profile selection remains available. Both image variants install the runtime tools as the `hermes` user.

The packaging acceptance inspects the built image and allows at most 126 layers,
reserving room for container layers. Run it alongside the boot acceptance when
changing this target or its base image:

```sh
MINDI_BACKEND_RUNTIME_IMAGE=mindi/backend-box:local \
  pnpm exec vitest run tests/backend-image-packaging.test.ts tests/backend-image-native.test.ts
```

Provide `MINDI_BACKEND_CONFIG` pointing to a mounted backend configuration and
`MINDI_BACKEND_TOKEN_FILE` pointing to a readable mounted token file (or the
explicit environment token). See `apps/backend/README.md` for the configuration
contract. `/home/agent` is persistent state; configure `stateRoot` beneath it.
The service runs as the image's `hermes` user. Mounted configuration and token
files must be readable by that user. The backend defaults to loopback. Set
`"host": "0.0.0.0"` in its configuration to admit connections through the
container interface. Keep published ports restricted to host loopback or route
through the operator-owned HTTPS ingress; the native desktop client accepts
HTTPS or loopback HTTP endpoints. Bearer authentication is required in both
bind modes. This image does not provision an ingress or certificates.

The native acceptance runs the image under Docker, creates a thread, stops and
restarts the whole container, and verifies the same creation receipt. It also
checks authenticated access from a second container, verifies the backend
process is present, and confirms legacy Hermes services are absent:

```sh
MINDI_BACKEND_RUNTIME_IMAGE=mindi/backend-box:local \
  pnpm exec vitest run tests/backend-image-native.test.ts
```

`DOCKER_HOST=ssh://box-host` is supported: fixture inputs use `docker cp`, avoiding
remote bind mounts of local paths. The runner removes its own container and
anonymous volumes and private internal network. It uses no provider credentials
or external network access.

The image pins OMP 18.1.17 (architecture-specific upstream release binary verified
against its SHA-256 and exact `omp --version` output during the build), Claude
Code 2.1.266, and Claude ACP 0.75.1. Rebuild this target to install the new OMP pin;
older image acceptance results do not establish acceptance for the rebuilt image.
The native CLI binaries are
on PATH. `MINDI_CLAUDE_ACP_COMMAND` selects the installed adapter so delegated
runs do not download an adapter at execution time. Authentication stays in the
native harness under the persistent home; no credentials are baked into the
image. The image acceptance checks CLI versions and real ACP initialization with
network access disabled. It does not call a model or prove provider login.

The release example leaves Hindsight disabled: its extraction and embedding
services require separate provider configuration and are outside this subscription-only
release. No paid provider credentials are required or injected. Hermes CLI subscription
settings are seeded at first boot, and existing operator settings and credentials are
preserved in `/home/agent`. See `../../../README.md` for the login and release procedure.


## Desktop connection over SSH

For an SSH-accessible box host, publish the container backend to a **fixed**
host-loopback port, for example `-p 127.0.0.1:65005:65005`, with the backend
configured for port 65005 and host `0.0.0.0`. From the desktop machine:

```sh
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -L 127.0.0.1:65109:127.0.0.1:65005 box-host
```

Save `http://127.0.0.1:65109` and the backend operator token in the app's
connection form. Keep the tunnel running while using that connection. Do not use
an ephemeral Docker host port for a saved tunnel: Docker can reassign it when
the container restarts. HTTPS ingress remains an alternative for operators who
already provide that infrastructure.

The compiled native desktop transport was tested through this path to a
packaged backend on the test host, including invalid-token rejection, discovery,
thread creation/read, and recovery of the same thread after container restart.
The native transport test does not prove rendered UI behavior or provide
automatic SSH connection management.

## First-start tools

Chrome 154.0.8037.97 (SHA256-verified vendor .deb), Claude Code 2.1.266,
and Claude ACP 0.75.1 are downloaded on first start, never at image build.
The npm dependency tree is pinned by `base/infra/agent-box/runtime-tools/package-lock.json`.
All downloads, caches and installed files live under the persisted `/home/agent`;
launchers are in `.local/bin`. Completed versions skip network access on restart.
Each install is bounded to 120 seconds; failures log a warning and leave the box
running without that tool. Failed installs retry on next start. The two tools
install independently. Chrome currently supports amd64 hosts only.
Updating a pin requires updating its checksum/lock and rebuilding the image.
Existing successful versions remain on the volume; no runtime deletion or apt
registration is performed. Network access to npm and dl.google.com is required
only when installing. The offline smoke deliberately verifies startup without
these optional tools; online image acceptance verifies installation and reuse.
