# HEX-192 evidence: Docker ownership, 30 npm path joins, native payload provenance

**Subject.** Image `sha256:3819c0400a46d16ed3307ac3caa419a669ac91b1c9490998335773d76e35731f` (OCI index; amd64 config `265e56d0…`), source `2a74043e8d639de3547d517f5b31665a83c4ec43`. Codi has not produced a LAN-built image for the newer head `17fa046`, so this is the HEX-188 image, unchanged.

**Method.** The work ran on the existing LAN builder on drone through a new LAN-only Dokploy project, `hex-192-evidence`. The image ran read-only with no network (`--network none --read-only`), and one pass of `os.walk` covered the final container filesystem: 165,993 files and 928 `package.json` files. dpkg ownership and md5 values come from the image's `/var/lib/dpkg/info`. No proof here relies on all-layer SBOM paths. Helper containers (`golang:1.25-bookworm`, `debian:trixie-slim`) only read a copy of `/usr/bin/docker` and fetched Debian artifacts. The image was not changed, pushed or deployed.

**Files.** `volume/` holds the raw facts (`facts/*.json`, `deb/`, `go/`, `run/`) and the probe scripts (`volume/scripts/`), and `volume/SHA256SUMS` covers them. `npm-30-join.{tsv,json}` is the joined table for the 30 rows. `upstream-binary-compare.txt` records the byte comparisons with upstream zips and the code references. `apt-lock-identity-rows.tsv` has the lock rows for the Debian packages that own these files.

## 1. Docker "UNKNOWN" Go main module: **joined to Debian docker-cli 26.1.5+dfsg1-9+b13**

| Check | Result |
|---|---|
| File | `/usr/bin/docker`, 30,721,152 bytes, sha256 `dcd65656…09b71`, md5 `00bae645…cc2`. `/bin/docker` is the same file through the usrmerge symlink. Dynamic PIE; its only NEEDED library is `libc.so.6`. |
| `dpkg -S /usr/bin/docker` | `docker-cli: /usr/bin/docker` |
| `dpkg-query` | `docker-cli 26.1.5+dfsg1-9+b13 amd64`, source `docker.io 26.1.5+dfsg1-9`, status `ii`. The full Built-Using list is in `facts/docker.json`. |
| `dpkg --verify docker-cli` | rc 0, no output: every file in the package is unmodified. |
| md5sums | `docker-cli.md5sums` lists `00bae64552d5b571a8910acdd1986cc2  usr/bin/docker`, which equals the file's actual md5. |
| Debian `.deb` | Fetched from snapshot by the lock's SHA1 `1d5ed5bf…` (size 7,337,584; SHA1 matches). `b13` has been superseded by `deb13u1`, so a current apt download was not possible. sha256 `842ab48440373eb31a66aef8f5579dfcb2e0b5cfda4a8e5bd3a4b9ab76b8a08b`. |
| Signature chain | `gpgv` verified the Debian archive keyring signature (rc 0) on snapshot `InRelease` for **trixie-proposed-updates at 20260510T144321Z** and for **trixie (stable) at 20260520T000000Z** (dated 2026-05-16, the point release). In both, the `Packages.xz` hash matches `InRelease`, and each index lists `docker-cli 26.1.5+dfsg1-9+b13` with SHA256 `842ab484…`. The lock's `first_seen` index (trixie, 2026-03-14) still listed `b12`, so `b13` came in through proposed-updates and then the point release. |
| Byte compare | The `.deb`'s `usr/bin/docker` has sha256 `dcd65656…` and is **byte-identical** to the image's file (`cmp` passes). |
| Go buildinfo | `go1.24.4`, `path github.com/docker/cli/cmd/docker`, `-trimpath`, `-tags=pkcs11`, CGO on. There is **no `mod` line and no vcs stamps**: Debian builds from a GOPATH-style vendored tree without module or VCS info. That is why Syft reports version `UNKNOWN`. `docker --version` prints `26.1.5+dfsg1, build a72d7cd`. |

**Verdict.** The SBOM row `github.com/docker/cli/cmd/docker@UNKNOWN` is the Go main module of `/usr/bin/docker`, which is owned by Debian binary `docker-cli 26.1.5+dfsg1-9+b13` (source `docker.io 26.1.5+dfsg1-9`). The proof is dpkg ownership, md5sums, `dpkg --verify`, and a byte-identical match with a `.deb` listed in two signed Debian indices. The row can join to the Debian source already retained in HEX-190 (`sources/debian/docker.io_26.1.5+dfsg1-9`).

## 2. 30 unmatched npm rows: **all 30 are present in the final filesystem at the exact name and version; none are absent**

- **29 rows** are owned by Debian packages under `/usr/share/nodejs/…` or `/usr/share/novnc/`. Every `package.json` passes its md5sums check, and `dpkg --verify` is clean for all 10 owning packages. These rows have no npm lockfile, so the lock identity is the owning package's `apt-packages.lock` row (snapshot URL plus `.deb` sha256).
  - `node-acorn 8.8.1+ds+~cs25.17.7-2` (source `acorn`) owns 16 rows: acorn 8.8.1, acorn-bigint 1.0.0, acorn-class-fields 1.0.0, acorn-dynamic-import 4.0.0, acorn-export-ns-from 0.2.0, acorn-globals 6.0.0, acorn-import-assertions 1.8.0, acorn-import-meta 1.1.0, acorn-jsx 5.3.1, acorn-loose 8.3.0, acorn-node 2.0.1, acorn-numeric-separator 0.3.4, acorn-private-class-elements 1.0.0, acorn-private-methods 1.0.0, acorn-static-class-features 1.0.0 and acorn-walk 8.2.0.
  - `node-undici 7.3.0+dfsg1+~cs24.12.11-1`: undici 7.3.0, undici-types 7.3.0, @fastify/busboy 3.1.1, binary-search 1.3.6.
  - `node-brace-expansion 2.0.1+~1.1.0-2`: brace-expansion 2.0.1, @types/brace-expansion 1.1.0.
  - `nodejs 20.19.2+dfsg-1+deb13u3`: @types/node 20.17.47.
  - `node-balanced-match 2.0.0-1`: balanced-match 2.0.0. `node-cjs-module-lexer 1.2.3+dfsg-1`: cjs-module-lexer 1.2.3. `node-corepack 0.24.0-5`: corepack 0.24.0. `node-minimatch 9.0.3-6`: minimatch 9.0.3. `node-xtend 4.0.2-3`: xtend 4.0.2.
  - `novnc 1:1.6.0-2`: @novnc/novnc 1.6.0, at `/usr/share/novnc/package.json`.
- **1 row**, `beep-boop 1.2.3`, is a test fixture inside `github-from-package@0.0.0`, at `/opt/hermes/plugins/platforms/photon/sidecar/node_modules/github-from-package/example/package.json` (sha256 `1b0a33ff…`). It has no lock entry of its own. The containing package's entry in `/opt/hermes/plugins/platforms/photon/sidecar/package-lock.json` has resolved `https://registry.npmjs.org/github-from-package/-/github-from-package-0.0.0.tgz` and integrity `sha512-SyHy3T1v…CmOOw==`.
- For every row, the table gives the exact path, the `package.json` name/version, the `package.json` sha256, a directory-manifest sha256 with file count, the dpkg owner and version, the md5 result, and the lock identity. Some names also exist at other versions elsewhere in the image (for example `/opt/hermes/node_modules/acorn@8.17.0`); those are listed in `other_versions_in_final_fs` and are separate rows, not these.
- **Why they were unjoined.** Devi's installed-package inventory came from `npm-installed-packages.json` (HEX-190), which only covered npm install roots with lockfiles. It did not cover the Debian-packaged `/usr/share/nodejs` tree or nested fixtures. Membership in the final filesystem is now proven directly.

## 3. Native payload provenance

### (a) FFmpeg: **two binaries ship**

| | Playwright ffmpeg | Debian ffmpeg |
|---|---|---|
| Path | `/opt/hermes/.playwright/ffmpeg-1011/ffmpeg-linux` | `/usr/bin/ffmpeg` (dpkg `ffmpeg 7:7.1.5-0+deb13u1`, md5 OK) |
| Size / sha256 | 5,101,056 bytes / `460d44f3…eaadc8` | 366,984 bytes / `e8a8d46f…e455a` |
| Linking | **static**: no PT_INTERP and no DT_NEEDED; `--extra-ldflags=-static` | **dynamic**: `ld-linux-x86-64.so.2` plus 10 NEEDED, using Debian `libav*61` 7.1.5 |
| Version | `n7.0.1-playwright-build-1011`, gcc 9.4.0 (Ubuntu 20.04) | `7.1.5-0+deb13u1`, gcc 14.2.0 (Debian) |
| Configure | `--disable-everything --disable-autodetect`, enabling only mjpeg decode, image2pipe, pad/crop/scale, webm mux and `libvpx`, all static | `--enable-gpl` plus about 70 external libraries, including `libx264` and `libx265` |
| GPL / version3 / nonfree | **none / none / none**. `-L` reports **LGPL-2.1+**, and `COPYING.LGPLv2.1` is shipped in the directory. | **GPL: yes** (`-L` reports GPL-2+); version3: no; **nonfree: no** |
| Origin | Hermes base Dockerfile `:201` runs `npx playwright install --with-deps chromium --only-shell` (playwright-core 1.62.1, `browsers.json` ffmpeg revision 1011). Download: `cdn.playwright.dev/dbazure/download/playwright/builds/ffmpeg/1011/ffmpeg-linux.zip`. The binary is **byte-identical** to the member in that zip, which was fetched and compared here. | Debian trixie package, inherited from the Hermes base image (`apt-inherited.tsv`). The source was retained in HEX-190. |

The Playwright build recipe is still private, as HEX-190 found. The FFmpeg n7.0.1 and libvpx v1.14.1 sources are retained there, but the static glibc/libgcc runtime from Ubuntu focal is not identified to an exact version.

### (b) Chrome: **Google "Chrome for Testing" headless shell, not Chromium from a distro**

- Path: `/opt/hermes/.playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell`. Size 196,975,952 bytes, sha256 `e11fc9ce…0a9f`. Dynamic, with 28 NEEDED libraries. It is not owned by any dpkg package, and **no `chromium*` or `google-chrome*` dpkg package is installed**.
- `--version` prints **`Google Chrome for Testing 151.0.7922.34`**. The binary contains the string "Google Chrome for Testing". The `ABOUT` file (sha256 `34d078ce…`) reads: "Google Chrome / Copyright 2026 Google LLC. All rights reserved. … made possible by the Chromium open source project … See the Terms of Service at chrome://terms." `LICENSE.headless_shell` (2.1 MB, sha256 `334f3e2d…`) holds the Chromium and third-party credits.
- Origin: the same `npx playwright install … chromium --only-shell` step. In playwright-core 1.62.1 (npm integrity verified), `cftUrl()` builds `builds/cft/151.0.7922.34/linux64/chrome-headless-shell-linux64.zip` on the `cdn.playwright.dev` mirror. The binary, `ABOUT` and `LICENSE.headless_shell` are **byte-identical** to the members of Google's official zip at `storage.googleapis.com/chrome-for-testing-public/151.0.7922.34/linux64/chrome-headless-shell-linux64.zip`. Google's known-good-versions list gives that build as Chromium revision 1654411.
- **Classification.** This is a Google-built and Google-branded binary from the Chrome for Testing channel, built from Chromium source. It is not a Chromium build from a distribution, and it is not the proprietary consumer Google Chrome with its extra codecs and components, but its `ABOUT` file asserts Google copyright and points to the Chrome Terms of Service. Redistribution terms need a licence decision (Mindi/Cari). The exact Chromium 151.0.7922.34 source tarball is retained in HEX-190; the GN build configuration is not published.

### (c) Bundled Claude from `claude-agent-sdk`: **proprietary Claude Code 2.1.285; shipped, but unreachable in the supported runtime path**

- Path: `/opt/hindsight/lib/python3.13/site-packages/claude_agent_sdk/_bundled/claude`. Size **240,327,864** bytes, sha256 **`33dad1ec615a2e08cc78b494f05c110e49916de2c79d78ec8799ebf46b233d29`**, mode 0755. Dynamic ELF with NEEDED libc, libm, libpthread, libdl and librt.
- Identity: `--version` prints `2.1.285 (Claude Code)`. The binary is a Bun v1.4.3 `bun build --compile` executable that embeds `@anthropic-ai/claude-code`. It comes from wheel `claude_agent_sdk-0.2.162-py3-none-manylinux_2_17_x86_64.whl` (lock sha256 `673598c9…`, and `direct_url.json` agrees). The wheel's `RECORD` entry `sha256=M9rR7GFa…` with size 240327864 **matches the file**. The wheel metadata declares MIT with a single `licenses/LICENSE` (sha256 `cebdde8a…`) for the SDK. No separate licence text for the bundled binary ships in the dist-info.
- SDK code that runs it: `claude_agent_sdk/_internal/transport/subprocess_cli.py`. `_find_cli()` (`:255`) checks `_find_bundled_cli()` first (`:258`, `:341–348`, `Path(__file__).parent.parent.parent / "_bundled" / "claude"`). If that is missing, it falls back to `shutil.which("claude")` (`:264`). `connect()` (`:802–803`) resolves the path, and `anyio.open_process([cli, "--output-format", "stream-json", "--verbose", …])` spawns it (`:574`, `:873`).
- Runtime callers in the image: only `hindsight_api` (hindsight-api-slim 0.6.1). `engine/llm_wrapper.py:206` creates `ClaudeCodeLLM` when the provider is `"claude-code"`, and `engine/providers/claude_code_llm.py:146/182` and `:351/470` build `ClaudeAgentOptions` **without `cli_path`**, so the bundled binary is used. The selector is `HINDSIGHT_API_LLM_PROVIDER` (config.py `:130`, default `openai`).
- **Supported agent-box path.** `runtime/memory.py:79–89` at `2a74043` builds Hindsight's environment from scratch ("Deliberately do not inherit HINDSIGHT_API_* overrides"). It accepts `MEMORY_LLM_PROVIDER` only as `openai` or `anthropic` and raises `ValueError` otherwise. The `claude-code` provider, and with it the bundled binary, **cannot be selected through the supported configuration**. It still ships (240 MB) and could run if someone started `hindsight-api` by hand with that provider. The redistribution disposition stays with Mindi, as HEX-189 records.

## Limits

- The `.deb` retrieval relied on snapshot's content-addressed store and the signed indices from May 2026. The current trixie index lists `deb13u1`, not `b13`.
- The 29 Debian-owned npm rows are proven by dpkg ownership and md5sums. There is no npm registry integrity for them, because Debian repackages them from source.
- Chrome and FFmpeg origin is proven by byte identity with upstream downloads made today. The exact build recipes remain unpublished, as HEX-190 found.
