# Third-party attribution — Incomplete

This directory retains original third-party notice bytes in `texts/`, with
SHA256, byte length, original path and evidence provenance in `manifest.json`.
`reconciliation.json` records component mappings, missing texts and unresolved
source obligations. A text match is not a complete license or source review.
Do not treat this partial collection as release or redistribution clearance.

The collected bundle comes from the linux/amd64 resolution build at source
`352b6eb5331030019eb26033675d2ab53d47459d`. The clean locked build at
`2a74043e8d639de3547d517f5b31665a83c4ec43` has matching Debian and installed
Python inventories and matching pg0, cua-driver and Tailscale binaries.
That comparison does not establish final-layer membership for all SBOM entries,
cache contents, native payloads or source-lock crate candidates.

Remaining work includes exact-version missing notices, binary dependency
membership, retained caches, embedded components and corresponding sources.
The prior malformed pg0 notice archive has been recollected successfully: it
is empty because the verified pg0 release source has no LICENSE/COPYING/NOTICE
file. MIT declarations alone do not supply the absent attribution text.

The integration and open work are tracked in HEX-181, with notice collection
in HEX-189 and source/artifact evidence in HEX-190. This file must be updated
with the final reconciliation before release acceptance. The original evidence
and conservative status fields are retained without claiming those gaps closed.
