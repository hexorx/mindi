# HEX-214 replacement candidate inputs

Source change only; this is not final image qualification. The earlier candidate
`56783726` remains rejected. Retain buildx `--provenance=mode=min` and save the
statement body, its SHA256, and subject-to-manifest validation for HEX-213.

## Verified resolution evidence

Opi's HEX-216 attachments: pass 1 SHA256
`b720b1473a7b0adddfd1a6e48d62cc36f7d48be5a0133ba38e5070234fdadd5a`,
pass 3 SHA256 `6d392c908b0967af759ffab1416e152b111f405c471e2332650f1adcf1777fca`.
The latter's 265 listed files verify. They are resolver evidence, not this image.

- Debian snapshots: `20260930T082601Z` and security `20260930T060347Z`.
  Use the top-level 158-artifact lock, not the broken nested candidate locks.
  Explicitly request the 27 inherited vulnerable packages after the desktop set.
  Opi installed all 158 artifacts with zero removals and matched the 553-row final
  inventory, including Chromium. All 114 prior Critical/High Debian rows fixed.
  Replaced-by-lock annotations now describe the additional inherited upgrades.
- Docker CLI: replace `/usr/bin/docker` with the binary from the digest-pinned
  official 29.8.1 image; verify SHA256 at build time. The Debian dpkg record still
  identifies its package version, while the actual executable is the official
  Go 1.26.8 binary, GitCommit `4a63305d74332de5ceba7fcbccbc3cbb7412f5ba`.
  Scans must distinguish the package record from the executable inventory.
- Hindsight: minimal compatible lift 0.6.1 to 0.8.3, with the `embedded-db`
  resolver extra. Seven packages change, none are added; CPU torch 2.8.0 remains.
  cryptography 50.0.2, transformers 5.15.1, sentence-transformers 6.1.0,
  huggingface-hub 1.33.0, sqlalchemy 2.0.54, pg0-embedded 0.15.2.
  The committed direct-wheel lock normalizes distribution-name spelling and retains the resolver mirror URLs
  for Jinja2/MarkupSafe (identical versions and artifact hashes).
- Hermes: full candidate pyproject/uv lock plus a narrow hash-pinned installed
  overlay for PyJWT 2.14.0 and anyio 4.14.2. Absolute resolution cutoff
  `2026-09-16T12:10:52Z`. Rebuild the editable project metadata with pinned
  setuptools 83.0.0 so its old PyJWT requirement cannot remain stale. This does
  not resolve or sync the rest of the inherited environment.

## Compatibility review

All five previously patched Hindsight migrations now use upstream Alembic
`autocommit_block()` and dialect dispatch. The old transform would nest these
blocks. The historical `patch_hindsight.py` entry point now only verifies exact
0.8.3 fingerprints and transaction structure, without writing upstream source.
Unmodified compressed fixtures cover that path and rejection of unsafe SQL.

pg0 0.15.2 source archive SHA256:
`b999ce0e22c21c776331f125919b3c26aebf98909289c179d9d73712a61cf01e`.
The private-loopback patch now includes the checkpoint command and extension
installer Settings, as well as allocation, startup and every URI. PostgreSQL
remains 18.1.0; pgvector changes to the upstream v0.18.320 bundle, hash
`2461d601bbf2c8ab3c70965be87dff92e5778d1610f9b294fcf23e32bd8a603e`.
libxml2 changes to the upstream .12 artifact; the rolling URL is gone, so use
Ubuntu's `20260701T000000Z` snapshot. Its downloaded SHA256 matches upstream
`b3678e6e4b166bc0e4226fb118d489ab51802c772914421397c9dcb2dd0e0d2b`.
ICU retains its existing pinned bytes and snapshot. Patches apply to the exact
source without fuzz; the Rust/container builds and real memory smoke remain gates.

Historical notices and HEX-189/193/194 dispositions are unchanged. Supplemental
wheel notices and Docker/Hindsight source licenses are under
`docs/third-party/hex214-security-inputs`. The old image's attribution joins are
historical evidence, not proof for changed bytes; final inventory reconciliation
must use the new candidate and identify any remaining supplemental notice gaps.

## Unresolved and acceptance gates

Tailscale stays at the existing digest-pinned v1.102.4: Opi verified that v1.102.5
still carries the same vulnerable x/crypto 0.54.0 and x/image 0.41.0. There is no
verified fixed stable release in that evidence. This is an open security residual,
not a claim of remediation or acceptance. Mindi owns its disposition before ship.
The inherited Hermes msal/cryptography constraint conflict remains explicit.

Devi must independently approve the exact head, and both CI checks must pass on
that head before merge. Opi must build on drone with the actual clean source
commit, save index/manifest/config IDs and the OCI image tar, capture provenance,
rerun Syft and Grype on those exact bytes, and enumerate every remaining fixable
Critical/High row with a reason. Retain all build evidence. No registry push,
production deployment, network/settings change, paid inference or cleanup is
part of this work. Runtime acceptance remains with HEX-212 after the new candidate.

Rollback before merge: supersede the feature branch; main and the existing image
are untouched. After merge: revert the source commit through a reviewed PR. Keep
candidate tags/tars distinct. No existing runtime volume is migrated by this PR.

## Follow-up to the first replacement scan

Opi built source `00d3b7e2a52fc3d3530093c6e515b8727e684a1a` in [HEX-223](/HEX/issues/HEX-223). Its hash-verified core attachment is `7b071c56225ca597f257945dbe9306ce25786154660f5f628b39a018de139d88`. Grype found 1 fixable Critical and 33 fixable High rows. The table below records that candidate only; it is not a scan of the follow-up source.

Hindsight now uses the same hash-verified setuptools 83.0.0 wheel as the Hermes build tools. Its vendored wheel is 0.46.3 and jaraco-context is 6.1.0, meeting the three reported fix thresholds. No other Hindsight lock artifact changes. Runtime compatibility and removal of these findings require a rebuilt candidate and fresh scan. Supplemental notices include all 17 setuptools license/notice files, the copyright from the exact libxml2 .12 deb, and the pgvector 0.8.5 upstream source license. The pgvector binary bundle contains no license; the source text does not establish source-to-binary correspondence or supersede historical accepted limitations.

Mindi’s [conditional Tailscale decision](/HEX/issues/HEX-214#comment-bfec05cf-b2b0-43c9-b1a5-5de36085d7e0) requires module/path scope, no KEV matches, and no fixed stable at scan time. The three rows below meet module/path scope; fresh KEV and stable-release evidence is still required. Inherited security findings are not automatically accepted by the historical notice dispositions.

| Severity | Finding | Package/version | Location | Reason/status |
|---|---|---|---|---|
| Critical | GHSA-23hp-3jrh-7fpw | tar 7.5.16 | `/usr/local/lib/node_modules/npm/node_modules/tar/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-2v37-7h3g-55p8 | nanoid 3.3.17 | `/opt/hermes/node_modules/sanitize-html/node_modules/nanoid/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-2v37-7h3g-55p8 | nanoid 3.3.17 | `/opt/hermes/node_modules/vite/node_modules/nanoid/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-3jxr-9vmj-r5cp | brace-expansion 5.0.6 | `/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-4w2j-m93h-cj5j | quinn-proto 0.11.14 | `/usr/local/bin/uv` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-4w2j-m93h-cj5j | quinn-proto 0.11.14 | `/usr/local/bin/uvx` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-58pv-8j8x-9vj2 | jaraco-context 5.3.0 | `/opt/hindsight/lib/python3.13/site-packages/setuptools/_vendor/jaraco.context-5.3.0.dist-info/METADATA` | Updated setuptools closure in source; rebuild/scan pending. |
| High | GHSA-5rjg-fvgr-3xxf | setuptools 78.1.0 | `/opt/hindsight/lib/python3.13/site-packages/setuptools-78.1.0.dist-info/METADATA` | Updated setuptools closure in source; rebuild/scan pending. |
| High | GHSA-6j4f-fj2g-mc7p | brace-expansion 5.0.6 | `/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-6j4f-fj2g-mc7p | brace-expansion 5.0.9 | `/opt/hermes/node_modules/brace-expansion/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-73wf-gq98-2v4g | browserslist 4.28.6 | `/opt/hermes/node_modules/browserslist/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-7mj9-2mp8-4m2p | httpcore2 2.7.0 | `/opt/hermes/.venv/lib/python3.13/site-packages/httpcore2-2.7.0.dist-info/METADATA` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-7mj9-2mp8-4m2p | httpx2 2.7.0 | `/opt/hermes/.venv/lib/python3.13/site-packages/httpx2-2.7.0.dist-info/METADATA` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-82j2-j2ch-gfr8 | rustls-webpki 0.103.10 | `/usr/local/bin/uv` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-82j2-j2ch-gfr8 | rustls-webpki 0.103.10 | `/usr/local/bin/uvx` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-8rrh-rw8j-w5fx | wheel 0.45.1 | `/opt/hindsight/lib/python3.13/site-packages/setuptools/_vendor/wheel-0.45.1.dist-info/METADATA` | Updated setuptools closure in source; rebuild/scan pending. |
| High | GHSA-8x88-c5mf-7j5w | tar 7.5.16 | `/usr/local/lib/node_modules/npm/node_modules/tar/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-8xx6-hgc6-gc2m | httpx2 2.7.0 | `/opt/hermes/.venv/lib/python3.13/site-packages/httpx2-2.7.0.dist-info/METADATA` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-c83g-rgw3-j3cx | browserslist 4.28.6 | `/opt/hermes/node_modules/browserslist/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-mh99-v99m-4gvg | brace-expansion 5.0.6 | `/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-mpf4-983q-p7j4 | tornado 6.5.7 | `/opt/hermes/.venv/lib/python3.13/site-packages/tornado-6.5.7.dist-info/METADATA` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-mwp4-54f8-5fhr | ip-address 10.2.0 | `/usr/local/lib/node_modules/npm/node_modules/ip-address/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-qhr7-859c-m2p7 | brace-expansion 5.0.6 | `/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-qhr7-859c-m2p7 | brace-expansion 5.0.9 | `/opt/hermes/node_modules/brace-expansion/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-r292-9mhp-454m | tar 7.5.16 | `/usr/local/lib/node_modules/npm/node_modules/tar/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-rfgv-xxqx-mfg5 | undici 6.26.0 | `/usr/local/lib/node_modules/npm/node_modules/undici/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-rfgv-xxqx-mfg5 | undici 6.28.0 | `/opt/hermes/ui-tui/node_modules/undici/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-rfgv-xxqx-mfg5 | undici 7.29.0 | `/opt/hermes/plugins/platforms/photon/sidecar/node_modules/undici/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-rgw5-rvv9-x895 | brace-expansion 5.0.6 | `/usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-vxpw-j846-p89q | undici 6.26.0 | `/usr/local/lib/node_modules/npm/node_modules/undici/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GHSA-w293-vg96-wgc3 | undici 7.29.0 | `/opt/hermes/plugins/platforms/photon/sidecar/node_modules/undici/package.json` | Inherited unchanged from pinned Hermes base; release disposition pending. |
| High | GO-2026-6303 | golang.org/x/crypto v0.54.0 | `/usr/local/bin/tailscaled` | No verified fixed upstream stable in supplied evidence; tracked by HEX-216; conditional acceptance checks pending. |
| High | GO-2026-6354 | golang.org/x/crypto v0.54.0 | `/usr/local/bin/tailscaled` | No verified fixed upstream stable in supplied evidence; tracked by HEX-216; conditional acceptance checks pending. |
| High | GO-2026-6355 | golang.org/x/crypto v0.54.0 | `/usr/local/bin/tailscaled` | No verified fixed upstream stable in supplied evidence; tracked by HEX-216; conditional acceptance checks pending. |
