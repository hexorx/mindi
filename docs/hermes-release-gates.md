# Hermes image release gates

Tracking: [HEX-97](/HEX/issues/HEX-97). Public visibility for
`ghcr.io/hexorx/agent-box-hermes` was approved by Josh on September 28, 2026.
This is separate from the source MIT grant and final dependency notice review.
Do not push an image until the evidence below is recorded on the ticket.

## Audit of main a65647d (September 29, 2026)

- [Gateway acceptance](/HEX/issues/HEX-95#document-integration-evidence)
  is complete for installed Paperclip fork `be8d58db` and box `a65647d`.
  Preserve the documented limits; this does not qualify a different release image.
- The source grant from merged PR #3 had been replaced by the earlier withholding
  record. This change restores its recorded decision without changing source
  hashes, file treatments, or the later Tailscale notice requirement.
- The Docker-specific context excluded all three build patch/helper files and
  `defaults/agent-box.json`. This change admits those exact files and the root
  LICENSE, installs that license in the image, and excludes common credential
  files and Python caches even beneath allowed directories.
- The Rust build-stage image remains tag-only. Apt packages and Python transitive
  dependencies remain floating. A versioned top-level pip requirement alone is
  not a reproducible lock. Resolve and pin these before claiming reproducibility.
- A final SBOM and complete third-party notice bundle are still required; the
  provenance ledger is an inventory, not that bundle. Reconcile actual inherited
  OS/Hermes/s6, desktop/fonts, cua-driver, Hindsight/pg0/PostgreSQL, Python/torch,
  and Tailscale/Go artifacts, including applicable source obligations.
- This runner has no Docker executable. Local source tests cannot establish a
  clean image build, image-layer secret scan, or runtime acceptance.

## Required publishing sequence

1. Finish immutable build inputs and third-party notices. Review and merge the
   release code under the different-agent approval and exact-head CI policy.
2. Build a clean linux/amd64 candidate without registry write permissions. Save
   its OCI digest, source commit, inputs, builder provenance and SBOM. Scan the
   final filesystem, image config/history, and every layer (including deleted
   files) for secrets; record the vulnerability report and its disposition.
3. Qualify that candidate against [the approved plan, section 8](/HEX/issues/HEX-85#document-plan):
   no-GitHub/no-Tailscale boot; authenticated desktop and actual screenshot,
   click and type; memory retain/recall across recreation; independent second box
   credentials and state; API stream/cancel/retry; shutdown and secret redaction.
   Record which checks are mocks and which exercise the real provider. Obtain
   any required spend authorization before paid inference.
4. Record license/notices, scan results, smoke evidence, CI and the candidate
   digest on the ticket **before** the push. Missing evidence fails closed.
5. A separate explicitly invoked publishing job gets `packages: write` only
   after these gates. Promote the exact validated artifact, with no rebuild.
   Refuse existing commit/version tags; record immutable tags and the registry
   digest. Do not create a mutable `latest` deployment dependency.
6. Verify anonymous pull for this approved public package. Hand the approved
   digest, config, backup, canary and rollback notes to Opi. Publishing must not
   trigger deployment. Rollback selects the prior digest/config and preserves
   existing volumes; shared data changes need their separate approval.

This document and its source checks do not certify the image for release.

## Replacement candidate identity and attestations (HEX-214)

Build the replacement from a clean checkout and pass its full `git rev-parse HEAD`
as `--build-arg SOURCE_REVISION`. The Dockerfile rejects missing/malformed SHA-1
IDs and labels the final scratch stage with the standalone mindi revision and
source URL. The builder must verify that label against its actual checked-out
commit; argument syntax validation alone cannot prove the context's identity.
CI uses its actual checkout commit, including a PR merge commit when applicable.

Keep BuildKit provenance with explicit `--provenance=mode=min`. Save the OCI
archive/index and **the full provenance statement blob**, not just the attestation
manifest digest. Record the statement's SHA256 and verify its subject names the
linux/amd64 image manifest in that index. Record the top-level index digest,
linux/amd64 manifest digest, config digest, source commit and image tar path
separately. A Docker image ID from a containerd store may be the index digest.
A classic Docker `--load` store can discard attestations; an image with missing
provenance is not an acceptable substitute for the retained-provenance candidate.
The desktop CI smoke's local load is not the release evidence export.

This is the attestation contract for [HEX-213](/HEX/issues/HEX-213). Its gate must
check the final OCI revision against the built mindi source commit, not against
upstream Hermes `e624e9fd`. Preserve that upstream identity separately through
the pinned base digest. Retain existing notice evidence and accepted residuals.
No statement body or rebuilt candidate has been captured by this source change;
[HEX-214](/HEX/issues/HEX-214) still requires the dependency updates, new image,
Syft/Grype evidence and independent exact-head review before completion.

## Exact-artifact promotion machinery

See [the promotion contract and operator sequence](hermes-promotion.md) for the
manual workflow, reviewed pre-push record, OCI index/platform/config identities,
report requirements and immutable-tag behavior. The machinery does not close any
candidate gate or supersede the accepted limitations above. No real release
record or registry push is included with its implementation.
