# Inherited Hermes security remediation (HEX-232)

This candidate starts from merged main `b3b78c7` after HEX-214. It is **not
qualified for public release**. The machine-readable
[28-row ledger](security-hex232-rows.json) retains every original advisory,
package/version and installed path; each row remains pending the exact-image
Syft/Grype scan on drone. No row is accepted merely because a version was changed.
The original HEX-223 core archive SHA256 was independently verified as
`7b071c56225ca597f257945dbe9306ce25786154660f5f628b39a018de139d88`.

## Changes

| Surface | Replacement | Finding rows |
| --- | --- | ---: |
| npm bundled dependencies | tar 7.5.22, brace-expansion 5.0.11, ip-address 10.5.0, undici 6.28.1 | 11 |
| uv and uvx | uv 0.12.21 (quinn-proto 0.11.18, rustls-webpki 0.103.14) | 4 |
| Hermes Python | httpx2/httpcore2 2.12.0, tornado 6.5.8 | 4 |
| Hermes Node trees | nanoid 3.3.18, brace-expansion 5.0.11, browserslist 4.28.7, undici 6.28.1/7.29.1 | 9 |

npm 12.2.0 still bundles brace-expansion 5.0.9 and undici 6.28.0, so upgrading
npm alone would leave findings. Retain npm 11.17.0 and patch its bundled packages
using the explicit installed-tree lock `hermes-node-security.json`. All tarball
bytes are SHA256 checked; all old target identities and archives are validated
before mutation. No npm install or lifecycle scripts run. Nested node_modules
are retained. The other package files are replaced entirely, removing obsolete
code within the disposable build filesystem. This does not modify a live volume.
A build-time Node check validates versions, Node engine compatibility and each
replacement's direct dependencies against the actual inherited tree.
Browserslist also requires baseline-browser-mapping 2.10.44 (previously 2.10.43).
The installed caniuse-lite 1.0.30001806 and electron-to-chromium 1.5.393 already
meet its updated bounds; the verifier checks them again at build time.

The overlay is authoritative for these installed paths. Upstream npm/pnpm
manifests and install locks remain historical base inputs, not a recipe for
reinstalling this patched runtime. Re-running upstream install commands can undo
these patches; runtime lazy installs remain disabled. Rebuild this Dockerfile to
reproduce the patched tree. This explicit overlay avoids an unrelated full Node
resolution and retains npm/npx and uv/uvx for agent/MCP tooling.

The Python project and full uv lock are relocked together with the narrow
hash-required, no-dependency wheel overlay. The global cutoff remains unchanged.
Only httpx2, httpcore2 and tornado change versions; httpx2-jsfetch is newly
represented for Emscripten in the cross-platform lock, not installed on Linux.
The rebuilt editable Hermes metadata advertises the new httpx2 requirement.

MSAL 1.36.0 declares `cryptography<49`, while the base explicitly overrides this
to cryptography 50.0.0. That pre-existing metadata mismatch remains, and no
claim of a clean whole-environment `pip check` is made. The build checks exact
MSAL/cryptography versions, RSA JWT signing/verification, MSAL token-cache use,
Tornado escaping, sync/async HTTPX2 requests without network, and the changed
Python packages' default dependency bounds. The changes do not alter MSAL,
cryptography, PyJWT or anyio pins. This is compatibility evidence, not a waiver
for unrelated security findings.

## Evidence and acceptance

The uv release archive is pinned to SHA256
`23f02075b652bb1df64178cfae41b5caf160822e720e2663568f3f5d63bc52c0`.
The [source/notice bundle](third-party/hex232-security-inputs/sources.json) records
artifact source URLs and hashes, replacement npm/wheel license bytes, uv license
texts and the uv 0.12.21 Cargo.lock. Cargo.lock is source evidence, not proof that
every crate is present in each executable; final binary SBOM membership and
notice reconciliation remain required on the new image.

Opi must build the reviewed exact head on drone into a distinct LAN candidate,
retain the OCI bytes/provenance, and scan those exact bytes with Syft and Grype.
For every ledger row, record the installed replacement/version/path and whether
the original advisory is absent. Match advisories/aliases and package paths;
absence of a package due to scan failure is not a fix. Report all new/changed
Critical/High findings separately. Repeat runtime smoke and final inventory/
notice gates, including npm/npx, uv/uvx, TUI and photon-sidecar module loading.
Do not transfer HEX-214's LAN-only disposition to new findings.

Codi owns the source and exact-head merge after another agent's approval and
passing CI. Opi owns the LAN build/scan. No registry push, public exposure,
production deployment, or deletion of prior candidate artifacts is authorized.
Rollback is a reviewed source revert and rebuilding the prior source as a
separate LAN candidate; retain the existing accepted candidate throughout.
