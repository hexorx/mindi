# Hermes extraction provenance

Tracking: [HEX-89](/HEX/issues/HEX-89). Authority: [approved HEX-85 plan, sections 1, 8 and 10](/HEX/issues/HEX-85#document-plan), revision `15796e3c-0e69-4e8b-8921-fe4d4bc1fdde`.

**Source inventory verified 2026-09-27. Josh's MIT grant on 2026-09-27 supersedes the earlier withholding decision.** [HEX-102](/HEX/issues/HEX-102) records the grant for the allowlisted inputs below. This change adds records only: no source code, compiled assets, or later multi-agent code is imported. The technical allowlist remains unchanged. The source-rights gate is satisfied for those inputs; P9 still requires third-party license and notice reconciliation before public image publishing.

## Immutable sources

| Role | Repository | Commit | Git tree |
| --- | --- | --- | --- |
| baseline | `mindi-dev/mindi-stack` | `b5ac82d8e6352cbb9716430f4dea560ad7d4266f` | `1ffc48217d44dda2b9d2bf8d739bb9eb2870e63c` |
| tailscale | `mindi-dev/mindi-stack` | `3ae5dec66c4c5610b45f81e6f09e20273b2c4748` | `6bed1235df2143c9e600cc6e0258e037bed71f53` |

Destination: `hexorx/mindi`, scaffold merge `859abd1d14d58da472ce3903f755bd4475f70044`. The provenance branch is based on this merge. The baseline commit timestamp is `2026-08-20T00:12:35Z`; the plan's August 19 label is descriptive, and the full hash is authoritative.

The baseline is the only extraction source. The later snapshot is an isolated Tailscale reference, never a replacement baseline. No wholesale copy, history merge, or whole-commit cherry-pick is allowed. The later Funnel addition `d46c6f6` (abbreviated in the plan) is excluded, as are all other unlisted revisions.

## Explicit file boundary

[extraction-allowlist.json](extraction-allowlist.json) enumerates exact paths and Git blob SHA-1 object IDs, the intended destination, and treatment. These are Git object hashes, not raw-file SHA-1 digests. No wildcard grants permission. Any absent path is excluded. Destination paths are planned implementation locations, not claims that code exists there.

- `adapt`: eligible baseline input; review and remove excluded behavior before importing it. No file is approved for blind copying.
- `reference`: inspect the requirement/lifecycle and implement deliberately; do not copy the full file. For the later Dockerfile only the Tailscale image/binary/service wiring is relevant.
- `exclude`: no extraction. The manifest explicitly classifies every baseline blob under `infra/agent-box/`, plus root `bootfetch.sh` and `stacks/agent-box/compose.yaml`; everything else remains denied by default.

The selected s6 definitions include their exact dependency and user-bundle marker files. Keep Sway, D-Bus, AT-SPI, wayvnc, noVNC, Hindsight and the single Hermes dashboard. Retain Sway/Waybar configuration and the Chrome Wayland wrapper. Apply these plan-section-1 rewrites:

1. Dockerfile: preserve official Hermes/s6 and uid 1000 runtime behavior; remove Buzz, broad sudo, default SSH and unpinned installers. Never carry blanket plugin/service COPY statements into the destination.
2. Computer-use configuration: implement structured configuration with Hermes/cua-driver behavior. Use destination TypeScript tooling; old helper build config is excluded.
3. Hindsight: isolate the venv and persistent volume, bind loopback, retain `local_external`; remove shell-sourced secrets and account-specific defaults.
4. Dashboard: retain only authenticated desktop viewing and the human dashboard; replace PAT-paste/account onboarding and unsafe VNC credential setup. The desktop plugin has only `plugin.yaml`, `dashboard/manifest.json` and `dashboard/dist/index.js` at baseline. The bundle is excluded; author maintained source and rebuild it. The separate `mindi-box` plugin is excluded.
5. Identity/entrypoint/bootfetch/compose: write independent box identity, optional config sources and standalone services. Remove mandatory GitHub/persona discovery, token waits, Infisical, executable remote hooks and shared infrastructure prerequisites. Root `bootfetch.sh` is not under `infra/agent-box/`.
6. Tailscale: adapt optional userspace lifecycle and file-backed enrollment, with independent state. Remove required persona naming, `--ssh`, raw VNC Serve, and shell-sourced secrets. Funnel is excluded.

Strip Buzz helpers/presence/relay/Redis/MinIO/database-init, Command/Control/webhooks/pairing tokens, herdr, reviewer/PM identities, secondary agents/orchestration, legacy Multica, later mobile/native transport, Infisical, credentials, `.env` files and account state. A retained file containing any of these must be rewritten before import. P3/P6 must review resulting diffs against this boundary; changing the boundary requires provenance review in the same PR.

## Source authorization decision

**Recorded state: authorized under the MIT License for the covered inputs.** Grantor and copyright holder: **Josh Robinson (`hexorx`)**, using the name on his [GitHub profile](https://github.com/hexorx). The existing root [MIT LICENSE](../LICENSE) contains `Copyright (c) 2026 Josh Robinson`; retain its copyright and permission notices in all copies or substantial portions of the Software.

On **2026-09-27**, Josh answered the human-only build-path question in [HEX-85, interaction `143e9180-0579-4458-a03b-7f70cc83b890`](/HEX/issues/HEX-85#interaction-143e9180-0579-4458-a03b-7f70cc83b890). He selected **“I own mindi-stack and grant rights; I will give license terms in a note”** and supplied **“MIT”** in the free-text field. Mindi (CEO) records that response as Josh, the rights holder, granting the MIT License for the allowlisted `mindi-dev/mindi-stack` inputs for use in `hexorx/mindi`.

Covered inputs are the manifest's `adapt` and `reference` entries at baseline `b5ac82d8e6352cbb9716430f4dea560ad7d4266f` and isolated Tailscale reference `3ae5dec66c4c5610b45f81e6f09e20273b2c4748`. The MIT terms permit use, modification and redistribution subject to retention of the copyright and permission notices. All technical boundaries and required rewrites above remain in force: excluded paths, compiled bundles, other revisions and wholesale history imports remain excluded.

### Superseded decision (historical evidence)

Earlier on 2026-09-27, Josh answered **“Withhold redistribution authorization”** in [HEX-89, interaction `f704bd0a-6b4a-460d-9ddc-12de70d18a6d`](/HEX/issues/HEX-89#interaction-f704bd0a-6b4a-460d-9ddc-12de70d18a6d). That response supplied no rights-holder assertion or license terms. **The later HEX-85 ownership assertion and MIT response explicitly supersede that withholding record for the covered inputs.** The manifest retains the old decision under `redistributionDecision.supersedes` for audit history.

Both pinned snapshots were inspected using complete recursive Git trees (`truncated: false`). Neither contains a tracked filename matching LICENSE, COPYING or NOTICE, case-insensitively. That historical filename-search result remains unchanged; the authority now comes from the subsequent rights-holder grant, not an inferred source-tree license.

P3/P4/P6 may proceed within the allowlist under this grant. P9's source-authorization condition is satisfied for the covered inputs, but **P9 must still fail closed until final dependency licenses, required notices and applicable source obligations are reconciled**. Hermes, Hindsight, Tailscale and other third-party dependencies retain their own licenses; this MIT grant does not relicense them or certify the final image for redistribution. This documentation change adds no release workflow or automated publishing gate. No deployment is authorized by this record.

## Third-party provenance and notice ledger

This inventory records observed build inputs, not an assertion of license compatibility or a completed notice bundle. Upstream license texts are not present in this source tree. Preserve required texts/attribution and any source-offer obligations from the exact artifacts selected during implementation. Never relabel dependencies as MIT under the destination license.

| Component | Evidence in pinned source | Required release evidence |
| --- | --- | --- |
| Hermes and inherited s6/base OS | Baseline Dockerfile: `nousresearch/hermes-agent:v2026.8.18@sha256:22e37bb4ed1b0f50cb6bd991dca7ecacd6c9f29df9b4a20fc989d32bc763ccf6` | Revalidate selected image; retain upstream notices and inherited package inventory. No registry availability claim is made here. |
| wayvnc / neatvnc / aml | Baseline Dockerfile clones `github.com/any1/wayvnc` at `v0.10.1`, `any1/neatvnc` at `v1.0.1`, `any1/aml` at `v1.0.0`; modifies neatvnc security-type registration | Pin resolved source commits; preserve each license/notice and record the modification. Tags alone are not immutable evidence. |
| Desktop, noVNC/websockify, fonts and libraries | Baseline apt installs Sway, Waybar, XWayland, D-Bus, AT-SPI, noVNC, websockify, fonts and supporting libraries without package-version pins | Record resolved packages/SBOM and preserve applicable package copyright files and source obligations. |
| Google Chrome | Baseline installs unversioned `google-chrome-stable` from Google's apt repository | Record exact artifact and applicable redistribution terms before shipping. |
| cua-driver | Baseline downloads `https://cua.ai/driver/install.sh` without a version/checksum | Replace with pinned artifact and retain its license evidence and notices. |
| Hindsight / pg0 and embedded runtime | Baseline Dockerfile installs `hindsight-api-slim[embedded-db]==0.6.1`; `start-hindsight.sh` sets `pg0` and loopback port 8888 | Resolve transitive artifacts, licenses and notices; a top-level version is not a complete dependency inventory. |
| Dashboard/plugin | Hermes base plus enumerated desktop plugin metadata; compiled-only desktop bundle excluded | Maintain authored source, lock dependencies, retain notices for any rebuilt assets. |
| Optional Tailscale | Later Dockerfile copies binaries from `tailscale/tailscale:v1.86.2` without digest pin | Record selected digest, binary dependency licenses and notices in P6/P9. |
| Build tooling | Baseline uses Debian 13.4, Node 20, TypeScript 5.8.3 and `@types/node` 22.15.3 | Use destination build tooling and record final build/runtime artifact boundaries. Buzz/Rust stage is excluded. |

P9 must reconcile this ledger with the final SBOM and ship actual required notices. This PR includes no upstream license texts because it includes no extracted executable code or dependency artifacts; it does not certify any future image for redistribution.

## Verification and handoff

GitHub commit and recursive-tree APIs verified full commit/tree IDs. The manifest records blob IDs from those trees; downloaded selected source bodies were checked against their Git blob IDs. Missing/new files must not be silently added by a future importer. Source inspection is not a runtime test.

This is documentation/data only. No behavioral tests were added. Original scaffold verification is recorded in [HEX-89](/HEX/issues/HEX-89); grant-update verification is recorded in [HEX-102](/HEX/issues/HEX-102) and its PR. The superseding MIT grant and historical withholding evidence are recorded above. Before P9 publishing, close every release-evidence item above and implement the fail-closed publishing gate.
