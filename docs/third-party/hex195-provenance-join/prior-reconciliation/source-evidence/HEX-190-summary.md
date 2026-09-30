# HEX-190 — Corresponding-source and retained-artifact reconciliation

Subject: final HEX-188 image, index `sha256:3819c0400a46d16ed3307ac3caa419a669ac91b1c9490998335773d76e35731f`
(manifest `5532c1cd…`, config `265e56d0…`), built from source `2a74043e8d639de3547d517f5b31665a83c4ec43`.
No rebuild was done. The image was run only read-only (`--read-only --tmpfs /tmp`, mostly `--network none`).

Retained evidence volume: `hex190-evidence` on the LAN drone, browsable at `https://hex190-evidence.mindi.stayho.me/` (LAN only).
The volume's `SHA256SUMS` covers **21,718 files** (everything except `run/` markers). The attached bundle holds every
non-source evidence file (64, all re-verified against `SHA256SUMS`), the analyzer scripts and compose, and the local analyses.

## 0. Source-grant repair (PR #13) preserved
The repair commit `ec4f9ea` is an ancestor of `2a74043`. `COPY LICENSE /usr/share/doc/agent-box-hermes/LICENSE` is present, and the `.dockerignore` changes are only additive.
The Mindi source tarball `sources/mindi/mindi-2a74043….tar.gz` is retained.

## 1. ensurepip
- All three interpreters use Debian `python3.13` 3.13.5. `ensurepip.version()` returns **25.1.1**, and there is **no `ensurepip/_bundled` directory** (Debian patch).
- The wheel ensurepip uses is `/usr/share/python-wheels/pip-25.1.1-py3-none-any.whl`, sha256 **`20568e5d750393b2a331d6b261886cbe5d62aca3f54d49a39815b7474d34cd9c`**.
  It is owned by `python3-pip-whl 25.1.1+dfsg-1` (source `python-pip`) and matches the dpkg md5sums.
- It is byte-identical to the member of the snapshot.debian.org `.deb` (sha256 `e65351935a…`, sha1 `8cd5a0eb…`).
  It is **not** the PyPI wheel. That wheel is retained too, for comparison.
- The retained Debian source `python-pip_25.1.1+dfsg-1` covers it: `.dsc` plus orig plus debian tarball, with `dscverify` OK.
- The Hindsight venv `pip-25.1.1` dist matches that wheel's RECORD 433/433, and its INSTALLER is pip. The Hermes venv was made by uv 0.11.6 and has no pip.
- Details: `facts/ensurepip.json`.

## 2. Debian corresponding source (inherited + added)
- **568 source/version pairs:**
  - 350 from installed binaries
  - 1 from binaries plus Built-Using
  - 217 Built-Using / Static-Built-Using only
- **All 568 are retained:** 2.225 GB, 1,811 files, 2,225 patches. Formats: 516 `3.0 (quilt)`, 34 `1.0`, 18 native.
- **Verification:**
  - Every file's sha1 matches snapshot, and every file's sha256 matches its `.dsc` Checksums-Sha256.
  - 558 `.dsc` signatures pass `dscverify`. The other 10 are signed by keys missing from the keyrings. For those, the `.dsc` sha256 was verified through a gpgv-verified snapshot `InRelease`, then `Sources.xz`.
  - 28 files were stored under their `.dsc`-listed names because snapshot aliases identical bytes under other names.
- **Ubuntu jammy sources** for the libxml2 2.9.13+dfsg-1ubuntu0.11 and ICU 70.1-2ubuntu1 libraries embedded in pg0 were retained via Launchpad, with `.dsc` checksums OK.
- Details: `debian/debian-sources.{json,tsv}`, `facts/dpkg-built-using.tsv`. Files are in `sources/debian/<src>_<ver>/`.
- The base image's `/etc/apt` stays rolling. The retained set is what shipped, not what a rebuild would get.

## 3. Non-Debian components: source and binary identity

| Component | Shipped identity | Retained source / proof |
|---|---|---|
| Hermes base | source `e624e9fde561…` | Source tarball retained (TOFU). Its Dockerfile pins are verified: SQLite autoconf 3530400 matches `0e948390…`, plus the uv, node and s6 tarball digests. |
| Mindi modifications | `2a74043` | `patch_hindsight.py` modifies the alembic files in `hindsight-api-slim 0.6.1` (RECORD drift recorded). Our pg0 build replaces `pg0/bin/pg0` (`dbb9bcc0…`). |
| s6-overlay v3.2.3.0 | 194 files (40 noarch + 154 x86_64) | **Byte-identical** to the official release assets, whose `.sha256` files were verified. Component sources are retained at exact tags: skalibs v2.15.0.0, execline v2.9.9.0, s6 v2.15.0.0, s6-rc v0.6.1.0, s6-linux-init v1.2.0.1, s6-portable-utils v2.3.1.2, s6-linux-utils v2.6.4.1, s6-overlay-helpers v0.1.2.2 (TOFU). |
| node 26.5.1 | `/usr/local/bin/node` plus 1,921 files in `/usr/local/lib/node_modules` | Byte-identical to the official `node-v26.5.1-linux-x64` tarball (SHASUMS verified) **and** to the pinned `node:26-bookworm-slim@sha256:9e6f…` image. The node source tarball is retained and verified. |
| uv / uvx 0.11.6 | `dc407e8e…` / `70ca4180…` | **Byte-identical to the pinned `ghcr.io/astral-sh/uv:0.11.6-python3.13-trixie@sha256:b3c543b6…`** image. They are not the GitHub release tgz build. The uv source and all 480 crates.io crates are retained, verified against the `Cargo.lock` checksums. |
| tailscale / tailscaled v1.102.4 | `0f78645a…` / `730f1114…` | **Byte-identical to the pinned `tailscale/tailscale:v1.102.4@sha256:2667…`** image. Source is commit `bbcd7d1f…`, built with the tailscale/go toolchain fork `7275f792…` (both TOFU). All 133 Go modules match their buildinfo `h1` sums. The module cache is retained. |
| cua-driver 0.30.1 | `e85d02d3…` | The release tarball is retained and verified (`82411700…`). Source is `039783f9…` (212 MB, retained), along with the 635-entry lock's crates. Only the `cua-driver` binary ships; `libcua_driver_sdk.so`, the bundled node and the cursor theme do not. |
| pg0 0.14.0 | `dbb9bcc0…` (our build) | pg0 v0.14.0 source (verified `729b27cd…`) and its cargo-verified crates are retained. |
| pg0 embedded PostgreSQL 18.1 | bundle `c8b2a68d…` | PostgreSQL 18.1 source verified against the ftp.postgresql.org sha256. theseus-rs build materials retained (TOFU). |
| pg0 embedded pgvector | bundle `2a26eb71…` | pgvector v0.8.1 and pgvector_compiled v0.18.237 retained (TOFU). |
| pg0 `runtime_libs` | bundle `f3c519c2…` | Ubuntu jammy libxml2/ICU. The `.deb`s match the `versions.env` sha256s; sources come via Launchpad (section 2). |
| Playwright Chromium headless shell | Chrome for Testing 151.0.7922.34 (`chromium_headless_shell-1234`) | Chromium 151.0.7922.34 source tarball (5.86 GB) retained and verified against Google's published sha256 `57330d6f…`. |
| Playwright ffmpeg-1011 | `n7.0.1-playwright-build-1011`, static | FFmpeg n7.0.1 and libvpx v1.14.1 sources retained. Build: GCC 9.4.0, Ubuntu 20.04, minimal configure (mjpeg/vp8/webm). |
| torch 2.8.0+cpu | wheel (not on PyPI) | torch v2.8.0 source tarball (331 MB) retained (TOFU). |
| Python dists | 355 sdists | Verified against PyPI JSON digests. No sdist exists for flatbuffers 25.12.19, onnxruntime 1.30.0 or psycopg-binary 3.2.10. hermes-agent 0.20.4 is covered by the Hermes source. |
| SQLite 3.53.4 | `/usr/local/lib/libsqlite3.so.3.53.4` | Autoconf tarball retained; matches Hermes' pinned sha256. |

Comparisons: `upstream/pinned-image-binary-compare.txt`, `upstream/phase3.json`, `upstream/upstream-fetches.json`, `go/go-modules-verify.tsv`, `python/pypi-sdists.json`.

## 4. npm and caches (final layer; nothing deleted or stripped)
- **Lockfiles (all v3):**
  - `/opt/hermes/package-lock.json`: 1,369 entries. 483 installed and verified identical to the SSRI-checked tarball, 871 not installed (optional or other platform), 7 links, 7 with no resolved/integrity.
  - Hermes `node_modules/.package-lock.json`: 492 entries.
  - photon sidecar: 137 entries, 135 identical.
  - whatsapp-bridge: 166 entries, not installed.
  - `_npx` playwright@1.62.1: 2 identical.
- **Known installed differences** from the tarballs, all explained:
  - `esbuild` `bin/esbuild` is replaced by its install script with the `@esbuild/linux-x64` native binary.
  - `@spectrum-ts/imessage` `dist/index.js` is patched by Hermes' `patch-spectrum-mixed-attachments.mjs`.
  - `better-sqlite3` includes the built `build/Release/better_sqlite3.node`.
- **Tarballs:** 590 retained in `sources/npm/sha512-<hex>.tgz`.
- **`/root/.npm`:** has **no `_cacache`**. The top level is only `_logs`, `_npx`, `_prebuilds` and `_update-notifier-last-checked`, so nothing cached needs reconciling beyond `_npx`.
- **`/root/.cache/uv` (358 MB):**
  - 138 `archive-v0` directories with 11,407 files; 10,884 are hardlinks into `/opt/hermes/.venv`.
  - Also present: `builds-v0`, `interpreter-v4`, `simple-v21`, `wheels-v6`.
  - `sdists-v9` holds python-olm 3.2.16 **plus the complete libolm build tree**: object files, test binaries, CMake files and Windows `ed25519` DLLs. These ship as part of the image and are covered by the retained python-olm sdist.
  - Details: `facts/uv-cache-structure.json`.
- **RECORD drift:** hindsight-api-slim (the Mindi patch), pg0-embedded (the pg0 binary replacement), and `wheel` (`bin/wheel` missing in Hindsight and the uv cache). Details: `facts/python-dists-record-verification.json`.
- **All-layer SBOM vs shipped:**
  - Squashed has 2,906 packages; all-layers has 2,922. 29 are only in all-layers and 13 only in squashed.
  - The only real removals are **15 superseded Debian versions** from base layers: at-spi, libc6/libc-bin 2.41-12+deb13u2, libssl3t64/openssl/openssl-provider 3.5.5 and 3.5.6, libsystemd0/libudev1 257.9, libcap2, liblzma5.
  - npm, Python, Rust and Go are identical by name and version. The rest are naming artifacts of binary/generic entries.
  - The final contents are the squashed set. Details: `analysis/sbom-all-layers-vs-final.json`.
- **Retained-file manifest:** every shipped path, with type, mode, size, sha256, link target and owner class, is in `facts/retained-file-manifest.tsv.gz`.

  | Owner class | Files | Size |
  |---|---|---|
  | dpkg | 28,321 | 1.43 GB |
  | py | 90,838 | 2.84 GB |
  | hermes | 37,740 | 488 MB |
  | unowned | 5,226 | 385 MB |
  | playwright | 294 | 278 MB |
  | npm-global | 1,921 | |
  | cache | 1,235 | |
  | s6 | 562 | |
  | mindi | 20 | |

## 5. Binary crate membership: what provenance proves
- **uv/uvx:** cargo-auditable `.dep-v0` gives an exact, compiler-embedded list of **542 packages**: 505 runtime and 37 build; 480 crates.io and 62 workspace. The uvx list is identical. **This is proven runtime membership.**
- **pg0:**
  - There is no dep-v0. Cargo metadata for Linux gives 239 crates.
  - The link closure is **207** crates (excluding proc-macros); 32 are compile-time only (build deps, proc-macros and their exclusive deps).
  - Embedded panic-path strings prove **83** crates, all inside the link closure. **124 linked crates have no binary evidence.**
  - Those 124 are in the closure by construction (built from our retained source and lock with rustc `e408947b…`), but the binary alone does not prove them.
- **cua-driver:**
  - There is no dep-v0. **147** crate paths embedded in the binary are proven.
  - They are all inside the 635-entry `Cargo.lock` superset. We cannot tell from the binary which of the other 488 lock entries are linked, compile-time only, or unused.
  - **The lock superset is not runtime closure.** The whole superset is retained so the source is complete. rustc `8bab26f4…`.
- **Rust napi bindings** (nemo-relay `_native.abi3.so` 108 crate paths, rolldown 124, tailwind oxide 26, lightningcss 23): embedded-path evidence only, with no audit data.
- **Details:** `rust/*binary-crate-evidence.json`, `rust/uv.dep-v0.json`, `analysis/rust-membership.json`, `upstream/crates-*.json`.

## 6. Support for Devi's notice collection
`notices/missing-notice-source-locator.json` covers every `text_status=="missing"` row in the Mindi `reconciliation.json`. For each row it gives the retained source archive and its license/notice members with sha256, so the notice text can be pulled from retained bytes. Summary:

| Row group | Retained archive, license member found | Retained archive, no license member | No retained source mapped |
|---|---|---|---|
| sbom-rust-crate | 664 | 124 | 0 |
| cua-rust-lock-candidate | 492 | 46 | 15 |
| sbom-go-module | 133 | 0 | 6 |
| sbom-python | 31 | 12 | 3 |
| sbom-binary | 18 | 2 | 1 |
| sbom-npm | 0 | 30 | 35 |
| python | 5 | 11 | 2 |
| inherited-s6 | 8 | 0 | 0 |
| pg0-embedded | 3 | 0 | 0 |
| pg0-rust | 0 | 6 | 0 |
| retained-cache | 0 | 1 | 0 |

The "no license member" rows need the notice taken from package metadata, headers, or the upstream repository. The "no retained source mapped" rows are listed individually in the JSON for Devi and Codi to resolve.

## 7. Irreducible gaps (stated precisely)
1. **Playwright ffmpeg-1011:** the build recipe has been private since 2022, and the statically linked Ubuntu focal glibc/libgcc versions can't be recovered from the binary. The FFmpeg and libvpx sources are retained; the static C runtime source is not identified to exact version.
2. **Chrome for Testing:** the exact GN build config and toolchain are not published. The source tarball is exact and verified.
3. **manylinux-vendored libraries:**
   - psycopg-binary / psycopg2-binary vendor libssl, libcrypto, krb5, ldap, sasl2, pcre, selinux, and **libkeyutils and libcrypt (LGPL)**, plus libpq.
   - pillow vendors about 18 image/font libraries.
   - scipy, numpy and sklearn vendor OpenBLAS and the GCC runtime.
   - The exact source versions come from the wheel builders' environments and are not recorded in the wheels.
4. **s6:** the static `x86_64-linux-musl` toolchain and musl version are not recorded. The release assets are verified byte-identical, and the component sources are retained.
5. **cua-driver:** 147 of the 635 lock entries are proven. Actual membership is between 147 and the superset.
6. **pg0:** 124 of 207 link-closure crates are unproven in the binary. The embedded PostgreSQL binaries link system libraries at runtime; only libxml2 and ICU are bundled (`pg0/embedded-needed-summary.txt`).
7. **esbuild native binary:** no Go buildinfo, so there's no module-level proof. Its version is the npm package version.
8. **Rust napi bindings:** no audit data; embedded-path evidence only.
9. **claude-agent-sdk 0.2.162 `_bundled/claude`** (240 MB, `33dad1ec…`): a proprietary Anthropic binary. **Redistribution terms need review.** There is no corresponding source.
10. **TOFU-only artifacts** (fetched by tag or commit with no published checksum): Hermes source, s6 component sources, the theseus-rs PostgreSQL build materials, pgvector and pgvector_compiled, the tailscale source and Go fork, the torch source, and the cua source.
11. **`/root/.npm` has no `_cacache`,** so there is no cache-level integrity record. Membership comes from the lockfiles and installed trees instead.
12. **Wheels with no PyPI sdist:** flatbuffers 25.12.19, onnxruntime 1.30.0, psycopg-binary 3.2.10. 31 dists lack dist-info license files: 13 hindsight, 12 system, 3 hermes-venv, 3 uv-cache.

## Infrastructure / safety
- Dokploy project `hex-190-reconcile`, compose `hex190-analyzer`. It is LAN-only, with the nginx file browser at `hex190-evidence.mindi.stayho.me`. Volume `hex190-evidence` is about 10+ GB.
- Nothing was pushed, deployed publicly, deleted, or spent.
- **Rollback:** stop or delete the compose. Deleting the volume is data loss and needs Josh's sign-off.
