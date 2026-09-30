# Dependency lock and notice evidence (work in progress)

This branch starts at PR #13's `ec4f9ea` source-grant and build-context repair.
It is not a reproducible release or a completed notice bundle. The Rust builder
is pinned by digest. The Hindsight wheel closure and embedded pg0 bundles now
use the resolved artifact hashes. Apt snapshot/artifact locking is integrated; final notice/source reconciliation remains incomplete. Runtime services and the extraction keep/strip boundary are unchanged.

## LAN builder handoff

Opi must use an existing authorized linux/amd64 LAN Docker builder. Build only:
no push, deployment, public exposure, paid resources or deletion. Retain build
outputs for Codi to inspect. Record host, Docker/BuildKit versions, exact git
commit, image ID, platform, timestamps, build log and hashes of evidence files.
Do not provide secret values or unfiltered environment/config dumps.

Build the branch's Dockerfile with a clean cache (`--no-cache --platform
linux/amd64`) using the repository root context. This first build is resolution
evidence, not final reproducibility acceptance. If a dependency fails, return the
exact package and sanitized error rather than upgrading it silently.

Use entrypoint-overridden, network-disabled containers to collect package
metadata, without starting the runtime or mounting persistent application data.
Mount `scripts/release/collect_inventory.py` read-only and run it with each
installed Python interpreter (system Python, Hermes venv if present, and
`/opt/hindsight/bin/python`). Add `--include-debian` to the system Python run.
The JSON preserves exact notice bytes with SHA256; missing notices remain
explicit. It does not import package code. Debian common license texts are
included because package copyright files may reference them.

Also return:

- Base OS release, architecture, apt source definitions and resolved apt package
  versions (including inherited packages); Python versions and `pip inspect`
  output for each environment, after checking outputs for private URLs.
- Available package artifact URLs/hashes and snapshot timestamp candidates for
  apt, plus wheel filenames/hashes and resolver reports. Do not substitute a
  top-level requirements list or `pip freeze` for a full artifact lock.
- Inherited Hermes/s6 source revisions and bundled notice files; Rust/Cargo
  inventories for pg0 and cua-driver; embedded PostgreSQL/pgvector payload
  versions and source links; Tailscale Go module/build inventory and licenses.
- SBOM for the built image using an existing authorized tool, with tool version,
  image ID and scan coverage. Explicitly list unsupported embedded artifacts.

## Completion gates owned by Codi

Use the evidence to check in immutable snapshot sources, the resolved package
closure and hashes, and hash-enforced Python installation inputs. Rebuild cleanly
on amd64. Reconcile every inventory entry with actual license/notice texts and
source obligations, including desktop/fonts, OS, Python/torch, embedded databases
and compiled binaries. Preserve referenced common license texts. Missing texts or
unresolved obligations remain release blockers, not blanket license assertions.

Obtain independent review and green CI on the final head. Parent HEX-97 retains
candidate-layer secret scans, smokes and pre-push/publication gates.

## Resolved Python and pg0 inputs (2026-09-30)

Opi's HEX-184 build of `352b6eb5331030019eb26033675d2ab53d47459d`
produced image `sha256:55422e9bab38e8be3cf1d28294acbd854dffafd23c9d0d6656da7a1589ee521c`.
Its Paperclip core evidence attachment is
`96db3014-d486-4d66-8102-db5a51e9ce54`; the summary is
`5df57957-f9c9-4f45-a5f9-60fcbf31973c`.

`build/hindsight-linux-amd64.lock` contains 214 unique wheel URLs and SHA256
hashes, covering every installed Hindsight distribution except `pip`, which
`ensurepip` supplies from the digest-pinned base. Generate it with
`scripts/release/lock_python.py --inventory <pip-inspect.json> --output <lock>
<r1.json> <r2.json> <r3.json>` using the ordered reports in
`run/python/resolver-replay.tar`. Later reports supersede earlier versions;
the generator refuses a closure that differs from the installed inventory.
The Docker build uses `--no-index --no-deps --only-binary=:all: --require-hashes`
and runs `pip check`, the migration-driver import, and CPU torch import.
No package resolver fallback or sdist build is permitted. Direct URLs preserve
PyTorch's CPU wheel source without making its index a global resolver source.
The inherited Hermes/system Python environments remain fixed by base digest;
this lock does not rebuild them or download local embedding model weights.

`build/pg0-bundle-hashes.patch` checks the PostgreSQL 18.1.0 and pgvector 0.8.1
bundles after download (or cache reuse) and before embedding. The SHA256 values
match both the actual built bundles and upstream release digests recorded in
`supplemental/pg0-embedded-upstream-digests.tsv`. Unsupported build targets fail
explicitly; this image already supports linux/amd64 only. Existing Ubuntu
runtime library checks and Cargo.lock enforcement remain in place.

The integrated locks were built under HEX-188; remediation head
`d37d1e9bce1ed8e30ce31a3a9f8ad4287c349448` was built under
[HEX-198](/HEX/issues/HEX-198) as image
`sha256:72e6ed46632973b999d8ae487eaac1f652bde94575deb3b9a9d9db64c8e42290`.
[HEX-199](/HEX/issues/HEX-199) approved that scoped remediation; the
[HEX-205 audit](/HEX/issues/HEX-205#document-audit) approved only dependency
input locks at that head and required broader acceptance repairs. These are
completed historical checks, not acceptance of a later head.

## Acceptance continuation (2026-09-30)

The four historical HEX-195 logs are restored with exact bytes and narrow Git
ignore exceptions. Existing manifests are unchanged; validate the committed
archive, not just a shared worktree. Missing historical `bin/docker` remains
disclosed. Bootstrap pip/setuptools wheel identity is supported by inherited
Debian ownership, base digest and matching final hashes; the failed private-API
ensurepip probe is not execution-tracing evidence.

Mindi accepted Photon Slack exclusion, implemented with HEX-206. Every changed
head requires corresponding LAN build, inventory/SBOM, independent review and
CI. HEX-207 owns the fresh build and the 20 added Debian packages' corresponding
source evidence. `scripts/release/reconcile_final_inventory.py` creates an
additive final overlay from shipped baseline bytes, final Syft artifacts and
per-environment inventories; historical rows/source_status remain unchanged.
Declared-only and native/build-source limitations remain accepted disclosures,
not closed obligations. No bit-for-bit reproducibility is claimed.

HEX-181 remains operator-held after acceptance. Neither this evidence nor a
successful review authorizes merge, publication, deployment or HEX-97 continuation.
