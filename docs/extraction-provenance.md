# Hermes extraction provenance

Tracking: [HEX-89](/HEX/issues/HEX-89). Authority: [approved HEX-85 plan, sections 1, 8 and 10](/HEX/issues/HEX-85#document-plan), revision `15796e3c-0e69-4e8b-8921-fe4d4bc1fdde`.

**Source inventory verified 2026-09-27. Josh withheld redistribution authorization on 2026-09-27; public image publishing remains gated.** This PR adds records only: no source code, compiled assets, or later multi-agent code is imported. The allowlist defines a technical boundary, not a license grant. P1 records the decision; completing this provenance task does not authorize redistribution or unblock P9.

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

**Recorded state: withheld — redistribution authorization has been explicitly withheld.** Josh approved the extraction plan and provenance work. That approval is not recorded as a source license grant. The destination MIT `LICENSE` does not establish rights for imported source or third-party components.

Both pinned snapshots were inspected using complete recursive Git trees (`truncated: false`). Neither contains a tracked filename matching LICENSE, COPYING or NOTICE, case-insensitively. This is a filename-search result, not proof of ownership or the absence of every possible embedded term. No source license is inferred or assigned here.

On 2026-09-27, Josh (board) answered the source-rights question in [HEX-89](/HEX/issues/HEX-89), interaction `f704bd0a-6b4a-460d-9ddc-12de70d18a6d`: **“Withhold redistribution authorization.”** The question covered the enumerated inputs at both pinned commits above. This records the board decision, not a claim that Josh owns those inputs. No rights-holder authority, license terms or attribution grant was supplied. The technical allowlist remains an inventory, not permission to extract or redistribute source. Private distribution is not an automatic workaround.

P9 remains blocked on redistribution authorization. Any later change requires a new explicit decision with owner/authority, covered inputs, permitted extraction and redistribution, exact license terms, required attribution, date and evidence; it must supersede this record explicitly.

P9 must fail closed while authorization is withheld and must separately reconcile final image dependency licenses/notices before public publishing. This documentation PR adds no release workflow or automated publishing gate; the enforcement belongs to P9. No deployment is authorized by this record.

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
| Optional Tailscale | Later Dockerfile copies binaries from `tailscale/tailscale:v1.86.2` without digest pin. P6 selected `tailscale/tailscale:v1.102.4@sha256:2667499ed87ae29218f292556ba062918402dd5e92e93637af14867e4df12dd3` (`tailscale` and `tailscaled` only) | Tailscale is BSD-3-Clause; P9 ships its license text and the Go module dependency notices for the selected binaries. |
| Build tooling | Baseline uses Debian 13.4, Node 20, TypeScript 5.8.3 and `@types/node` 22.15.3 | Use destination build tooling and record final build/runtime artifact boundaries. Buzz/Rust stage is excluded. |

P9 must reconcile this ledger with the final SBOM and ship actual required notices. This PR includes no upstream license texts because it includes no extracted executable code or dependency artifacts; it does not certify any future image for redistribution.

## Verification and handoff

GitHub commit and recursive-tree APIs verified full commit/tree IDs. The manifest records blob IDs from those trees; downloaded selected source bodies were checked against their Git blob IDs. Missing/new files must not be silently added by a future importer. Source inspection is not a runtime test.

This is documentation/data only. No behavioral tests were added. Scaffold build, lint, typecheck and test results and the PR check status are recorded in HEX-89. The withholding decision and its evidence are recorded above. Before P9 publishing, obtain a superseding authorization decision, close every release-evidence item above and implement the fail-closed publishing gate.
