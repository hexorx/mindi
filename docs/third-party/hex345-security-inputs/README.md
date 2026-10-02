# Chromium/Expat immutable input preparation

Built provenance remains `501f3992423ac2feab3dcf0201f6c493999cfb76`. The branch incorporates PR #38 head `78dfade53d681f8e39cc5073b8df0d8f22252fa7`: GitHub compare confirms tooling merge `6168482c5f1675e90a85adc9a993420bb05fb6cd` is two commits ahead of the built source and one ahead of the PR head, with an identical PR-head/merge tree. The net tooling diff replaces only 22 `layer_digest` fields in `security/secret-allowlist.json`; it grants no new-image secret PASS.

## Authenticated inputs

Snapshot: `debian-security/20261001T172817Z`, suite `trixie-security`, amd64. `InRelease` records 2026-10-01 17:27:37 UTC and expiry 2026-10-08 17:27:37 UTC. Sequoia `sqv --cleartext` verified both signatures using the installed Debian archive keyring; fingerprints and command/exit status are in `signature.json`. The retained compressed Packages and Sources sizes/SHA256 match the signed release. The old Debian and security snapshots remain in the installer for every unchanged artifact.

`binary-records.json` and `binary-verification.json` record all four actual artifact downloads, source identities, sizes, immutable URLs and SHA256. `.deb` control fields were inspected and agree with the index. `source-records.json` locks all seven corresponding source artifacts; all seven were downloaded and their actual sizes/hashes verified, including the 995,122,080-byte Chromium original tarball. The source descriptors are retained here. Source descriptors are authenticated through signed Sources; no independent maintainer-signature PASS is claimed. Preserve the historical 355 VALID / 11 NO_PUBKEY qualification separately.

Copyright files were extracted non-executingly from the four verified `.deb` archives. Opi must collect these exact seven source artifacts into the new ordered source companion, replace the four binary/source joins, regenerate notices and payload inventory from the new image, and verify companion/image agreement. These input records do not bind a future image digest or close prior license gaps.

## Scope and resolver evidence

The expected final inventory retains 553 packages and changes exactly chromium/chromium-common `.57 → .92` and libexpat1/libexpat1-dev `2.8.2 → 2.8.3`. The base has 432 packages; the installer transaction becomes 121 additions + 39 upgrades (160 artifacts), because Expat now replaces inherited bytes explicitly. All 156 non-target lock rows remain byte-identical. Inherited Expat base/source identity remains historical; its byte owner now names the replacement lock.

The retained frozen-candidate dpkg status was compared with all 553 baseline inventory rows before an isolated `apt-get -s` against the four verified local `.deb` files. Result: exactly four upgrades, zero additions/removals. No package was installed. `resolver.json` records the command, status hash, output and return code. The installer derives exact-version preferences from the entire expected final inventory and rejects other versions; it still compares the full simulated base-to-final transaction before any download/install. No broad upgrade is authorized.

`advisories.json` retains all 17 remediation groups and 34 distinct native memberships, current Debian fixed versions, target comparisons and per-advisory Linux qualifications. Platform-specific advisories do not imply Linux vulnerable-code presence; Expat UTF-16/non-wide-build invocation remains unresolved. The other Expat/Chromium advisories and all prior unresolved rows remain in the qualification ledger. No finding is declared cleared by these input checks.

All digest-pinned build stages, x/image v0.41.0, and Go/Node/Python lock inputs remain unchanged. Regression tests check those hashes as well as the exact four-package inventory and artifact delta.

## Build/release gate

This branch skips only its pull-request Hermes desktop image job: a candidate build must wait for different-agent exact-head approval and green source CI, then Opi owns LAN-only execution. The regular source CI remains active. No image was built, installed, deployed or published during input preparation. No paid call was made.

Opi handoff remains gated on review, CI and merge. It must carry the complete approved HEX-342 plan and re-qualification matrix: fresh identity/reproducibility; both Syft/native/SBOM and exact-binary Go scans; 1880 = 501 + 11 + 34 + 34 + 1300 crosswalk plus eight separate Go rows; new-byte secret scan/allowlist and four controls; companion/notices/raw evidence; functional and SUID enforcement checks; all six runtime qualification reruns. Use mocks first and at most two hours for residual probes, one baseline/control and 60-second process timeouts. US$0 paid authorization remains in effect. Historical evidence never becomes new-digest acceptance.

Rollback is a reviewed revert PR. Opi may stop an isolated candidate while retaining artifacts/volumes, restoring only an already-authorized LAN configuration. Frozen b9e211a2 remains preserved and not release-cleared.
