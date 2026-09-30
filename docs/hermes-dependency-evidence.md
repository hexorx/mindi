# Dependency lock and notice evidence (work in progress)

This branch starts at PR #13's `ec4f9ea` source-grant and build-context repair.
It is not a reproducible release or a completed notice bundle. The Rust builder
is pinned by digest; apt and Python resolution still require the target-image
inventory. Runtime services and the extraction keep/strip boundary are unchanged.

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
