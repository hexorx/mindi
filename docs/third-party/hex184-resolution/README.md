# HEX-185 notice bytes and reconciliation — incomplete release closure

This repository-neutral handoff contains actual, unmodified third-party text bytes from HEX-184. It does **not** certify complete notices, corresponding source, or redistribution readiness. No repository, Dockerfile, dependency lock, source grant, or extraction boundary was changed. Codi owns the `hexorx/mindi` branch/PR and image integration; Devi's assigned repository scope is `mindi-dev`.

Evidence identity: `hexorx/mindi` base commit `352b6eb5331030019eb26033675d2ab53d47459d`, image `sha256:55422e9bab38e8be3cf1d28294acbd854dffafd23c9d0d6656da7a1589ee521c`, linux/amd64. This is the resolution build, not Codi's later candidate or final acceptance image.

## Contents and verification

- `bundle/texts/<sha256>.txt`: 1,161 unique original byte streams. The `.txt` suffix is a storage convention; encoding and line endings are untouched.
- `bundle/manifest.json`: 2,238 provenance records mapping original paths and evidence containers to text bytes, lengths and SHA-256.
- `bundle/reconciliation.json`: 4,164 rows across package inventories, all-layer SBOM artifacts, source lock candidates, hidden embedded components and caches. Overlapping rows are intentional; this is not 4,164 unique installed dependencies.
- `bundle/verification.json`: verified input files and per-category missing counts. All 90 available files listed in the supplied run/followup checksum lists passed. Files absent from the selected evidence parts are not claimed verified.
- `inputs.json`: Paperclip attachment identities and downloaded archive hashes.
- `assemble.py`, `verify.py`, `test_verify.py`: standard-library-only generation and validation. No package installation or fetched artifact execution.

Run `python3 verify.py bundle` and `python3 -m unittest discover -s . -p 'test_*.py'`. Rebuild with `python3 assemble.py /path/to/hex184-evidence-352b6eb /fresh/output`. Inputs are the HEX-184 core, inventory, notices/lockfiles, and Syft tar archives, unpacked safely with Python's `filter='data'` into the same evidence root. Generation requires Python 3.11+; safe extraction requires a Python version supporting the data filter.

## Coverage and missing texts

| Surface | Reconciliation result |
| --- | --- |
| Debian, desktop, fonts | All 533 exact package copyright captures and 17 common-license captures retained; includes inherited packages. Package/source names and versions are recorded. Text presence does not establish source availability. |
| Installed Python / torch | 368 environment-specific rows; 18 missing texts after 16 explicit Debian-package candidate mappings. Torch 2.8.0+cpu has two captured files; review nested bundled library coverage. |
| pg0 Rust | 239 Linux-filtered metadata rows, 233 with captured version-matched crate text. Missing: crc-catalog 2.4.0, pg0 0.14.0, postgresql_archive/commands/embedded/extensions 0.20.0. Metadata includes build dependencies; not a proved runtime closure. |
| Embedded pg0 payloads | PostgreSQL 18.1.0 COPYRIGHT and LICENSE captured. pgvector 0.8.1, Ubuntu libxml2 2.9.13+dfsg-1ubuntu0.11 and libicu70 70.1-2ubuntu1 have no collected exact text. Do not substitute Debian host versions. |
| cua-driver | MIT root text at source commit 039783f9221a08c0daf9cda65a460fc4f346fa6e captured. All 635 source-lock rows retained; 82 have shared pg0 crate text candidates, 553 have none. Neither the lock nor strings proves binary membership. |
| Hermes / s6 | Exact Hermes LICENSE retained at revision e624e9fde561e1add9388384012b295fde669ade. All eight s6 family version rows explicitly lack captured texts. |
| Tailscale / Go | All 139 SBOM artifact rows retain module versions, h1/build metadata and binary locations. No exact module notices captured. Module hashes are not notice texts. |
| npm | All 802 SBOM rows considered; 737 have path-associated text candidates, 65 have none. Nested node_modules do not satisfy their parent's notice. Syft used all layers: the same filesystem path is not proof of version/layer identity. |
| uv/uvx Rust | All 1,010 SBOM rows retained; 222 version-match captured crate text, 788 lack it. These are candidates, not a proved complete uv notice bundle. |
| Retained caches | Six uv cache paths captured, including libolm subcomponent texts. Root .npm lacks a reconciled text set. Dist-info matches from installed Python cannot prove complete cached wheel/sdist/build-tree coverage. |

The 18 installed Python misses are enumerated by name, version and environment in reconciliation.json. It also enumerates every unmatched npm, Go and Rust row. The separate 401 all-layer Python SBOM rows have 46 unmatched rows, including versions/locations not proven by installed metadata.

`run/rust/pg0-source-notices.tar` is malformed: its first bytes are a directory listing, and Python tarfile rejects it. It was checksum-verified as an evidence file but excluded from notice parsing. Extension `.control` files in the embedded archive are metadata and were not counted as license texts.

## Source obligations and integration gate

Every reconciliation row deliberately retains `source_status: not_reconciled`. This prevents captured permissive text or a common GPL/LGPL text from being mistaken for fulfillment of source duties. This is an engineering evidence queue, not a legal determination.

1. **Debian / desktop / fonts:** retain per-package copyright and referenced common-license bytes. Use the recorded source package/version to reconcile exact source archives, Debian patches and build materials. GPL/LGPL and font-specific terms need component review; neither a rolling mirror nor a snapshot URL alone proves corresponding source is retained and deliverable. See HEX-184's artifact and superseded-package tables.
2. **Hermes / s6 / browser / ffmpeg / node:** preserve the inherited source revision, modifications and bundled notices. Review browser/headless-shell and ffmpeg captures and their component/source requirements, not only Hermes' root grant. Obtain missing version-specific s6 and runtime texts.
3. **cua-driver / Rust / uv:** establish shipped binary dependency membership and map exact crate versions/checksums to license and NOTICE files. Source-lock supersets and shared crate versions are provisional. Preserve upstream copyright and selected-license attribution; investigate any source/disclosure conditions at component level.
4. **pg0 and embedded libraries:** retain patched pg0 source/build instructions and the exact two baseline patches; Codi owns subsequent hash-lock changes. Obtain missing pg0 crate texts and pgvector/Ubuntu-library notices. Reconcile PostgreSQL bundle contents and transitive embedded libraries against exact archives, not the visible SBOM alone.
5. **Python / torch:** reconcile exact installed/replayed wheel hashes and source versions, then native payloads and nested notices. Missing dist-info texts need version-specific upstream distribution evidence. The two torch text files alone do not prove all native components' obligations fulfilled.
6. **Tailscale / Go:** use both binary build-info lists and h1 sums to obtain version-specific module archives, Go toolchain/runtime notices and any bundled component texts. Replacements and pseudoversions need exact-source provenance.
7. **npm and retained caches:** reconcile lock/artifact integrity, final layer membership and all retained archives/build trees to their own notices. Review cache contents even when unused at runtime. No deletion or cache stripping is authorized by this handoff.

Codi should import only these new notice/reconciliation files on an isolated branch from `hex-181-dependency-locks` commit `352b6eb`, review what is suitable for repository storage, and open the focused PR. Preserve PR #13's source grant and extraction keep/strip boundary; do not import private source trees or unrelated evidence. Do not alter Dockerfile/lock ownership. Re-run against the final locked LAN build and arrange a different agent's exact-head review plus CI. Missing-text/source rows remain release blockers until resolved or explicitly dispositioned with evidence. This artifact authorizes no publishing, deploy, spend, data deletion, or repeat human gate.
