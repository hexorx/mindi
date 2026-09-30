# Buzz bounded startup — HEX-201

This derivative image retains `ghcr.io/block/buzz:sha-82f7ed1` and adds a small
Python startup supervisor. It does not disable or alter A3. No production action
is part of this change.

## Root cause and evidence

Incident: following the 2026-09-30 drone boot, the relay stayed running but
unhealthy for about 4.5 hours. Its final log was `running git object-store
conformance probe (A3 gate)`. The 07:21:57 UTC manual restart recovered by
07:25:04 UTC. See [HEX-201](/HEX/issues/HEX-201) and
[HEX-200](/HEX/issues/HEX-200).

Inspected upstream commit `82f7ed1532f50e0d28afca5580ed522f1c2ef1ca`:

- [main.rs:503–536](https://github.com/block/buzz/blob/82f7ed1532f50e0d28afca5580ed522f1c2ef1ca/crates/buzz-relay/src/main.rs#L503)
  awaits `run_conformance_probe` with no outer deadline or retry. Existing knobs
  enable/disable the probe or change race width/rounds; none set a timeout.
- [store.rs:576–883](https://github.com/block/buzz/blob/82f7ed1532f50e0d28afca5580ed522f1c2ef1ca/crates/buzz-relay/src/api/git/store.rs#L576)
  performs S3 PUT/GET/DELETE, including cleanup DELETEs whose errors are ignored
  but whose completion is still awaited. The first network operation is
  `put_pack` → `put_immutable` →
  `Bucket::put_object_with_content_type_and_headers`. Both race phases use
  `join_all`, so one stalled racer prevents the entire phase from finishing.
- [GitStore::new](https://github.com/block/buzz/blob/82f7ed1532f50e0d28afca5580ed522f1c2ef1ca/crates/buzz-relay/src/api/git/store.rs#L212)
  calls `Bucket::new` without configuring an HTTP timeout. The locked
  `rust-s3` **0.37.2** is compiled with `tokio-rustls-tls`.
- In that exact crate, [Bucket::new](https://docs.rs/crate/rust-s3/0.37.2/source/src/bucket.rs)
  (lines 637–649) initializes `ClientOptions::default()`. Its separate
  `request_timeout` field says 60 seconds, but
  [the Tokio backend](https://docs.rs/crate/rust-s3/0.37.2/source/src/request/tokio_backend.rs)
  (lines 21–39) derives the options default with `request_timeout: None` and
  only configures reqwest's total timeout when it is `Some`. The actual request
  awaits `client.execute(request)` at line 114; response-body reads can also
  wait. The downloaded crate SHA-256 matches Cargo.lock:
  `aeedb13abdaa7e48d391de05b0569b37fa0a7a64a668dff6ffb2141ad0c2527e`.

**Confirmed defect:** an unbounded S3 request can hold the A3 gate indefinitely.
The probe has no filesystem/JuiceFS calls; `buzz-git` is not its direct I/O path.
MinIO or its network being slow/unavailable at boot is a plausible trigger,
not a proven incident-level cause. The existing single start log cannot tell
which PUT/GET/DELETE, race, or response-body await hung. The original process
was restarted, and no stack/request trace was supplied. Do not claim the first
PUT specifically hung. A future upstream fix should configure
`with_request_timeout` (not merely `set_request_timeout`), add per-phase
tracing, and wrap the whole probe with cancellation-safe retry/deadline logic.

## Bounded recovery

The health listener is bound in
[`serve`, after A3 completes](https://github.com/block/buzz/blob/82f7ed1532f50e0d28afca5580ed522f1c2ef1ca/crates/buzz-relay/src/main.rs#L1255).
The supervisor polls `127.0.0.1:$BUZZ_HEALTH_PORT/_readiness` (default 8080).
It therefore bounds all startup, including A3, without parsing logs or
weakening conformance. It requires the existing isolated container network
namespace: do not run it with host networking or a shared health-port sidecar.
The existing `BUZZ_GIT_CONFORMANCE_PROBE=true` must remain unchanged.

Defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| `BUZZ_STARTUP_TIMEOUT_SECONDS` | 300 | Deadline per complete startup attempt |
| `BUZZ_STARTUP_ATTEMPTS` | 3 | Maximum attempts (valid range 1–10) |
| `BUZZ_STARTUP_BACKOFF_SECONDS` | 5 | Exponential delay; 5s, 10s by default, cap 60s |
| `BUZZ_STARTUP_STOP_GRACE_SECONDS` | 10 | SIGTERM grace before SIGKILL |

After 200 readiness, the deadline is permanently disarmed; the healthy relay
can run indefinitely. Post-start health is still owned by existing monitoring.
A timeout stops/reaps the child before another attempt. After exhaustion the supervisor
exits 1, allowing `restart: unless-stopped` to recover. An explicit relay failure
(including an A3 violation) exits immediately with its non-zero code; it is not
converted to success or hidden by in-process retries. The container restart
policy remains the outer retry loop. SIGTERM/SIGINT interrupt startup, runtime,
or backoff; process-group forwarding includes relay subprocesses. The compose override
enables Docker `init` to reap orphaned descendants.

Default worst-case startup cycle is approximately 948 seconds: 3 × (300s +
10s grace + up to 1s reap) + 5s + 10s, plus polling/scheduling overhead. Three
attempts are bounded; Docker may retry cycles indefinitely while storage is down.
A process stuck in uninterruptible kernel I/O may not die even after SIGKILL;
the supervisor refuses overlapping retries and exits non-zero. This cannot
repair a host kernel/mount failure by itself.

The five-minute budget exceeds the observed 187-second recovery start, but
needs validation under cold-start load. Timeouts rerun the whole application
startup, not just A3; the existing relay itself already restarts this way.
Probe objects may accumulate as upstream documents; this change adds no data
cleanup, migrations, or retention policy changes.

## Test and build

```sh
python3 -B -m unittest discover -s stacks/buzz/tests -v
python3 -c "import ast, pathlib; [ast.parse(p.read_text()) for p in pathlib.Path('stacks/buzz').rglob('*.py')]"
docker build -t buzz-startup:hex-201 stacks/buzz
```

The dedicated CI workflow runs process-level tests, syntax validation, the
image build (without publishing), and entrypoint/non-root smoke checks. Tests
use local fake relays and loopback HTTP only, covering hangs, retries, recovery,
HTTP stalls/503, failure exits, healthy runtime, config validation and signals.
They do not exercise production storage. The author environment has no Docker
binary; container-build verification is delegated to this CI job.

## Opi rollout and rollback

1. Have a different agent review the exact PR head and record its approval.
   Require CI green on that head before normal/squash merge. Do not deploy
   an unreviewed build or bypass a failing check.
2. Build the derivative image from the merged `stacks/buzz` directory; resolve
   and record the base image digest and resulting immutable image digest.
   Use an existing approved private registry or local image workflow. Do not
   publish a new public image/package as part of preparation.
3. Read-only: export the existing `Hive/buzz` compose (`h5I-1u92Ll5G72mJH3z-r`)
   and record the current image digest, service key, entrypoint, command,
   health port, mounts, secrets references and healthcheck. Keep secret values
   out of the ticket/git. Confirm the service really is `buzz-relay`, isolated
   networking, and no compose entrypoint override bypasses the supervisor.
4. Test the built image on an isolated LAN test fixture with disposable test
   services/credentials: storage that accepts a connection but never responds,
   delayed storage recovery, a non-conforming response, healthy startup beyond
   five minutes of runtime, and docker stop. Confirm no real data or live
   startup migrations are involved. Do not point this fixture at production.
5. Batch the public production rollout and rollback restart into **one Josh
   approval**. Include immutable digest, rendered compose diff, test evidence,
   expected interruption, and rollback. Buzz is public: LAN deploy autonomy
   does not authorize this service's production change.
6. Once approved, merge `compose.override.yaml` into the existing compose with
   `BUZZ_SUPERVISED_IMAGE` set to the tested immutable image reference. Preserve
   the probe flag, all storage/configuration, and existing Docker healthcheck.
   `stop_grace_period: 15s` allows the supervisor's 10s grace + reap overhead.
   Deploy through Dokploy; observe attempts, readiness, restart counts, and
   normal git/media checks. Do not simulate a production storage outage.
7. If admission loops or service checks regress, restore the exact saved image
   and compose (including entrypoint/command, stop grace and added settings),
   then redeploy under the approved rollback. No volume restore, deletion,
   probe-disable, or data migration is needed. Keep existing watchdog behavior.

Codi prepares the PR; the assigned reviewer owns sign-off/merge, and Opi owns
image acceptance, the batched production approval, rollout and rollback.
