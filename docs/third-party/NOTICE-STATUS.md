# Third-party attribution — Incomplete

This image ships collected upstream notice bytes and explicit gaps under
`/usr/share/doc/agent-box-hermes/third-party/`. `manifest.json` records SHA256,
byte length, original path and provenance; `reconciliation.json` records
component mappings, missing texts and unresolved source obligations. A text
match is not complete license or corresponding-source review.

## Evidence baseline

The collected bundle comes from the linux/amd64 resolution build at source
`352b6eb5331030019eb26033675d2ab53d47459d`. The clean locked build at
`2a74043e8d639de3547d517f5b31665a83c4ec43` has matching Debian and installed
Python inventories and matching pg0, cua-driver and Tailscale binaries.
That comparison does not establish final-layer membership for all SBOM entries,
cache contents, native payloads or source-lock crate candidates. Historical
inventory rows remain evidence about that baseline, not proof of membership
in a remediated image.

## Declared licenses and missing upstream text

Mindi's HEX-193 disposition permits declared-only components to ship with the
explicit status **declared license only; upstream notice text not found**.
This is an accepted notice limitation, not evidence that missing text was found.
It covers pg0/pg0-embedded, cobble, declared-only npm rows, Photon telegram-ts
and otel, and @nous-research/ui. The exact-version row reconciliation accompanies this image under
`hex195-provenance-join/prior-reconciliation/`, with declared-only rows and
font/GSAP disposition under `hex195-provenance-join/prior-disposition/`. No copyright holder may
be inferred from an author field. No SPDX template is upstream notice text.
Nested dependency notices do not supply a missing project-root notice; cobble's
vendored inflection notice applies only to that vendored file.

## Accepted P9 residuals — known limitations, not closed

The following source/build limitations are accepted as disclosed residuals for
P9 under HEX-193. They are not release blockers and must not be labelled closed:

- **Manylinux vendored libraries:** exact corresponding sources for every bundled
  native library are not established by Python wheel metadata or a wheel hash.
- **s6 musl toolchain:** the exact static musl/toolchain source identity is not
  established by the retained s6 release sources alone.
- **cua/pg0 linkage bounds:** source-lock inventories are supersets; source
  membership and notice matches do not prove which crates were linked into the
  shipped executables. Keep proven binary evidence separate from candidates.
- **Native bindings and esbuild:** retained package sources and integrity values
  do not close all native payload, static dependency and build-recipe gaps.
- **TOFU source identity:** matching retained archive hashes records the bytes
  observed on first retrieval; it does not create an upstream signed identity.

The original conservative `source_status: not_reconciled` and membership fields
remain in the evidence. Acceptance of these residuals does not change them.

## Remediation still requiring changed-image evidence

HEX-193 requires exclusion of the proprietary bundled Claude executable and
@photon-ai/whatsapp-business 0.1.1, including copies in distributed layers and
caches. Claude must use an operator-installed official executable with a clear
missing-install error; the WhatsApp Business path must be disabled in this
flavor. These requirements are not yet proven by the baseline inventory.

HEX-192 supplies FFmpeg and Chrome provenance. A private-recipe static FFmpeg
requires replacement with Debian ffmpeg or the exact recipe and corresponding
sources in the notice bundle. Proprietary Google Chrome requires replacement
with Debian chromium. Neither requirement is covered by the accepted residuals
above. The final changed head still requires a clean amd64 LAN build, updated
inventory/notices, green CI and independent exact-head approval.

Track implementation in HEX-193 and integration in HEX-181; notice reconciliation
is in HEX-189 and source/artifact evidence in HEX-190/HEX-192. This file records
Mindi's disposition without claiming full closure or release readiness.

## Additive evidence and implementation scope

`hex195-provenance-join/` preserves the 4,164 baseline rows and source_status
values byte-for-byte. Its joins establish historical Debian ownership for
29 npm rows, containing-package integrity for one fixture, and Docker's Debian
identity. They distinguish dynamic GPL Debian FFmpeg from Playwright's static
LGPL binary, identify Google Chrome for Testing, and trace the Claude binary.
The joins cover source `2a74043` / image `3819c040…`, not the changed image.
Run the included `verify_join.py` to verify attachment-byte consistency; this
is not a runtime or signature verification rerun.

The Docker remediation now excludes the payloads above in a sanitized scratch
final stage, selects Debian Chromium/FFmpeg, disables WhatsApp Business, and
replaces all 14 proprietary font hashes with system-font usage. GSAP notices
and separately labelled linked terms remain in the additive evidence. The
build writes `payload-remediation.json` and runs the filesystem absence check.
Changed-head LAN/all-layer evidence and independent exact-head approval are
still required before claiming remediation verified. See
`docs/payload-remediation.md` in the source repository for operator behavior.
