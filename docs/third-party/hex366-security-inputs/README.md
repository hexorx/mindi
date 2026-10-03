# HEX-366 successor input preparation — F1–F4 complete

Base: `1d10342a3a027fed532fb46be4cbb7437fd7a2ef` (candidate `b02a240c`). Branch: `codi/hex-366-fix-now`.

F1–F4 source changes are prepared for all 89 fixable rows. This is not a release-cleared candidate; the new image still requires build, rescan and disposition rejoin. `row-mapping.json` retains every native row identity and target, including all five F3 overlay rows. Neither `gate.py` nor `promote.py` changes.

## F1 — 71 findings, 15 binary packages

- util-linux, mount, libblkid1, liblastlog2-2, libmount1, libsmartcols1, libuuid1: `2.41.5-0+deb13u1`.
- bsdutils: `1:2.41.5-0+deb13u1`; login: `1:4.16.0-2+really2.41.5-0+deb13u1` (Debian epoch/compatibility versions preserved).
- libpng16-16t64: `1.6.48-1+deb13u6`.
- libsrt1.5-gnutls: `1.5.4-1+deb13u1`; librabbitmq4: `0.15.0-1+deb13u2`.
- libasound2t64 and libasound2-data: `1.2.14-1+deb13u1`; sed: `4.9-2+deb13u1`.

Immutable snapshot selection: `20261002T120000Z`. ALSA and sed are in signed **debian/trixie**, not trixie-security; the remaining targets are in **debian-security/trixie-security**. Both InRelease signatures were verified with the installed Debian archive keyring. Each compressed Packages/Sources file matches its signed SHA256 and size. Initial security-index path downloads disagreed with InRelease; hash-addressed downloads matched and replaced those untrusted inputs before any lock was generated. `by-hash-fetch.json` records the accepted URLs.

All 15 binary archives and all 19 corresponding source archives were downloaded and SHA256/size verified. Binary package/version/architecture control fields were checked. Source descriptors and available copyright files are retained; source authenticity is through signed Sources, not a claim about independent maintainer signatures.

All 160 prior lock rows remain unchanged. Fifteen inherited packages now explicitly replace base bytes: 175 locked artifacts = 121 additions + 54 upgrades; final inventory remains 553 packages. Exact final-inventory preferences prevent broad upgrades. Requested packages explicitly include all new replacements. A read-only apt simulation against the retained candidate status proves exactly 15 upgrades, zero additions/removals. No package was installed on the host. `resolver.json` includes the command, status hash and output.

## F2 — 6 findings, 12 exact npm artifacts

`/opt/hermes` gets colord 2.9.4, baseline-browser-mapping 2.11.0, sanitize-html 2.17.7, brace-expansion 5.0.12, vitest and @vitest/mocker 4.1.11. Vitest's exact dependency closure also requires @vitest/{spy,utils,expect,runner,snapshot,pretty-format} 4.1.11. All 12 tarballs were checked against registry SHA512 integrity and locked by computed SHA256; package identities and dependencies were read from actual archives. Available licenses are retained.

The existing installed-tree overlay is the authoritative image lock; inherited upstream project install locks do not describe that overlay. No lifecycle scripts or floating npm resolution run. Existing nested dependencies are retained. All 60 overlay dependency edges pass semver checks against the candidate's retained installed inventory plus this overlay. New-image build-time validation still checks actual installed identities, Node engines and dependency closure.

## F3 — 5 findings, approved hash-locked npm overlay

Inspected current release tarballs:

| npm release | bundled ip-address | bundled brace-expansion |
| --- | --- | --- |
| 12.2.0 (latest) | 10.5.0 | 5.0.9 |
| 11.21.0 (next-11) | 10.5.0 | 5.0.9 |
| 10.9.9 (next-10) | 10.1.0 | 2.0.2 |

None meets the requested >=10.7.1 / >=5.0.12 pair. See `npm-release-inspection.json` for archive hashes. Mindi approved the existing installed-tree overlay on 2026-10-02 (comment 2e868c35-f25c-4a51-bbad-d45c9e3eb518). Global npm now receives ip-address 10.7.1 and brace-expansion 5.0.12. Archive SHA512 integrity, SHA256, package metadata and dependencies were verified; `npm-overlay-verification.json` records inputs and hashes. The archive package.json files are installed intact, so rescan sees the fixed versions.

The build retains the existing installed dependency-closure validation and adds `RUN --network=none` for `verify_npm_security.mjs`. It recursively rejects every installed copy below the npm root below either fixed floor, requires both packages, runs npm --version, then offline npm ls and npm pack against an isolated local fixture with lifecycle scripts disabled. Regression coverage injects vulnerable nested copies of both packages. Local CLI smoke passed against the inspected npm 12.2.0 archive with these exact overlays; this is supplemental, not a claim of testing the inherited image. Container CI exercises the actual inherited CLI. Replace the overlay with a qualifying npm release in a later reviewed PR.

## F4 — 7 findings

PyJWT 2.15.0 wheel and sdist hashes, URLs, sizes and upload times are synchronized in the installed overlay and uv lock; pyproject, editable package metadata and Dockerfile version assertion agree. Only PyJWT receives an exclude-newer exception; the global cutoff and other package versions remain unchanged. Both PyPI artifacts were downloaded and hashed.

Hindsight pip is used only for image-build installation and `pip check`, then uninstalled in the same build step. An import-absence assertion follows. The repository's runtime does not invoke Hindsight pip; Hermes's separate runtime tooling is unaffected. Full Hindsight startup/import qualification remains a new-image build check.

## Handoff and rollback

Managed GitHub identity is unavailable in this heartbeat. The complete tested patch is handed to Mindi for the existing credentialed courier path. Devi reviews the exact head, and `check` + `container` must pass on that head before merge. No candidate image was built here; Docker is unavailable locally.

Opi's subsequent LAN build/rescan and disposition rejoin remain under HEX-350. The 1719 no-fix rows do not become accepted by these source changes; all newly observed rows remain unresolved until classified. New-byte secret scan and allowlist binding must use the new layer digest. No publication, production action, spend, or deployment occurred. Rollback is a reviewed revert PR; existing runtime and candidate artifacts were not modified.
