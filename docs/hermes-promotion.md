# Exact-artifact Hermes promotion

This is publishing machinery, not release authorization or a claim that the
current candidate passes. The accepted locks, notices, original source records,
and [residual disclosures](hermes-release-gates.md) remain unchanged.
[HEX-213](/HEX/issues/HEX-213) implements the gate;
[HEX-212](/HEX/issues/HEX-212) supplies qualification, and
[HEX-97](/HEX/issues/HEX-97) owns the final pre-push record/publication.

## Trust boundary and sequence

1. Build/qualify in the existing authorized environment **without package-write
   credentials**. The existing desktop CI workflow is also read-only. Promotion
   never builds, runs the image, executes report content, runs a candidate script,
   or accepts a Docker config ID as a registry digest. A new build is a different
   candidate and requires new scans and runtime evidence, even with equal inputs.
2. Export the exact OCI graph to `image.oci.tar`. The archive's `index.json` must
   have one descriptor identifying an OCI index containing one linux/amd64 manifest plus one buildx provenance
   attestation (unknown/unknown). Unattested single manifests are refused. Retain the whole graph;
   do not flatten it, recompress layers, or drop attestations. The attestation's
   raw in-toto statements must also be in the provenance attachments. All blobs
   and descriptor sizes are checked; unrelated blobs and external URLs fail.
3. Run Syft and Grype against **that archive**, and content-level secret scanning
   across the final filesystem, config/history and every layer, including deleted
   contents and attestation layers. Record scanner/ruleset/DB versions, errors,
   redacted native reports and reviewed vulnerability dispositions. Filename-only
   scans, an SBOM-only vulnerability scan, archive parse errors, unresolved
   findings and stale evidence cannot qualify. The gate verifies recorded results;
   it does not invent or rerun scanners or replace independent evidence review.
4. Run all section 8 runtime gates against that exact **published subject digest**.
   Every gate records real-vs-mock explicitly. Mock, skipped, failed, missing or
   different-digest results fail. Paid inference requires a separately authorized
   approval reference; this workflow performs no inference.
5. Assemble the flat **ZIP_STORED** bundle described below. Split into ordered
   parts of at most 1 GiB if necessary. An authorized coordinator stages them as
   draft-release assets in **hexorx/mindi**, without publishing a release. Record
   numeric IDs, sizes and SHA256 values, plus the combined ZIP SHA256. No arbitrary
   URL, repository, shell fragment, artifact name or destination is accepted.
6. Record all evidence and the release-record digest on the parent ticket **before
   push**. Commit `releases/hermes/vX.Y.Z.json` through a focused, independently
   reviewed PR to main. Record data and reports are a reviewed trust root, not
   self-authenticating attestations. Review must verify native reports, exception
   approvals, exact-source approval, source-input equivalence if applicable, and
   component-by-component corresponding-source delivery/valid offers. The tool
   checks identities, completeness and statuses; it cannot make a legal finding.
7. On **main**, manually dispatch `Hermes exact-artifact promotion` with `record`
   (the version), the exact file `record_sha256`, and `promote=false`. Qualification
   has `contents: read` and `checks: read`, with no package permissions. Both
   source and accepted commits must be ancestors of main, and the latest `check`
   and `container` GitHub Actions checks on the accepted commit must be successful.
8. Only after all gates pass, an authorized coordinator explicitly dispatches
   again with `promote=true`. Qualification runs first; a fresh isolated job gets
   `packages: write`, redownloads the hash-pinned assets, rechecks every byte/gate,
   verifies main has not moved, then publishes. Manual inputs are environment
   values, never shell substitutions. Checkout is SHA-pinned and persists no token.

The reviewed source may differ from the actual built source only with reviewed
matching Docker-input manifest hashes. This does **not** make an image built in CI
identical to the LAN candidate. The final OCI revision label must equal
`source_commit` (the actual standalone **mindi** commit). Keep the upstream
Hermes commit separately in `provenance.upstream_revision` and base evidence.
Old upstream-labelled candidates cannot pass; a new build needs full qualification.

Native provenance is mandatory, with subject equal to the amd64 manifest. The
supported local-context BuildKit schemas are SLSA v0.2 (`predicate.buildType`
`https://mobyproject.org/buildkit@v1`) and SLSA v1 (`predicate.buildDefinition.buildType`
`https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md`).
Both in-toto Statement/v0.1 and Statement/v1 envelopes are accepted. Read VCS from
v0.2 `predicate.metadata["https://mobyproject.org/buildkit@v1#metadata"].vcs` or
v1 `predicate.runDetails.metadata.buildkit_metadata.vcs`. Require `source` exactly
`https://github.com/hexorx/mindi` (optional `.git`) and `revision` exactly
`source_commit`; missing metadata, dirty suffixes and unsupported schemas fail.
These are the native fields populated from `vcs:source`/`vcs:revision` options.
Retain explicit `--provenance=mode=min` and the complete raw statement bytes.

[BuildKit documents](https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md)
that local-context VCS metadata is client-supplied and unverified. Matching it is
an identity consistency gate, not proof of a trusted build. Independent review
of native build logs, clean source/input inventories and the evidence record on
main remains mandatory. Report repetition or a detached unsigned statement cannot
replace the embedded provenance. Other schema/context forms require a reviewed
contract change before use.

## Source companion pointer and metadata-only rebuilds

Every image carries `io.hexorx.source-companion.url` with the predetermined URL
`https://github.com/hexorx/mindi/releases/tag/hermes-source-<source_commit>`.
`<source_commit>` is the full actual built mindi commit, also used by the OCI
revision label. Stage the image transport assets and source companion parts in
that same release. Its tag is `hermes-source-<source_commit>`; the promotion
record's semantic `version` still selects the GHCR version tag. Reserve this
release URL before building; do not derive it from the image digest or companion
checksum, since the companion itself binds the image identity. Do not replace
assets at an already published pointer. Draft assets are staging only: before
public image availability, the release and matching source assets must be
recipient-accessible and their exact bindings verified under the publication gate.
Adding this label alone does not implement the companion promotion verifier or
authorize publishing either the release or image.

A label change changes the config digest, platform manifest, provenance subject,
and index digest. It does not add filesystem content. For a rebuild from otherwise
identical Docker inputs, compare the ordered layer descriptors and config
`rootfs.diff_ids` with the prior candidate before asserting filesystem equivalence;
a cached build or unchanged package list alone is insufficient. Retain the original
candidate and its evidence unchanged. Inspect the new image's companion and OCI
revision labels with `docker image inspect` or `crane config` and record all full
digests, built source, comparison results and provenance binding.

The prior source acquisition run remains useful when these filesystem identities
match, but is not evidence of the new image's identity. Reuse verified source
payload bytes only after checking the new inventory. Regenerate the companion's
README/manifest subject bindings (index, platform, config and built source),
`source-companion-<digest12>` filenames, internal checksums, packed parts and outer
checksums/asset record. A filename-only rename is insufficient. Rerun exact-subject
qualification and promotion verification; do not silently relabel old reports.
If filesystem layers differ, reassess and rerun source acquisition for changed
components as well. The ongoing HEX-220 run against the prior candidate can
continue; rebinding for the new candidate follows verified equivalence.

## Bundle and JSON contract (version 1)

The bundle contains exactly `image.oci.tar`, eight report JSON files, and the raw
attachments enumerated in the record. No directories, symlinks, duplicate names,
encryption or compression. Raw attachment names match `raw-[a-z0-9][a-z0-9_.-]*`.
Archives are streamed/hashed; OCI paths are never extracted. Maximum bundle or
unpacked size is 64 GiB; each transport asset is at most 1 GiB. Preflight requires
five times the transport size plus 1 GiB free for staging and anonymous pull.
Insufficient disk fails; this task does not provision a larger runner.

[The synthetic contract example](hermes-promotion-example.json) contains a record
and all eight report envelopes. It is **not release evidence**, is deliberately
expired, uses the rejected legacy smoke schema, and has no real transport assets.
Use [schema 2](hermes-smoke-schema.md) for new smoke reports. The executable contract is
[`gate.py`](../scripts/hermes-release/gate.py); the offline test fixture exercises
the indexed OCI shape and rejection of unattested images.

Record fields:

| Field | Required meaning |
| --- | --- |
| `schema_version`, `destination` | `1`, `ghcr.io/hexorx/agent-box-hermes` |
| `source_commit`, `accepted_commit` | Full 40-character actual-build and independently approved Git commits |
| `version` | `vMAJOR.MINOR.PATCH`, optional lowercase prerelease; never `latest` |
| `manifest_digest` | Exact root **registry subject**: OCI index digest |
| `index_digest` | Same as root digest; required indexed candidate |
| `platform_manifest_digest` | Exact linux/amd64 manifest digest; never a config ID |
| `archive_sha256`, `bundle_sha256` | SHA256 of exact OCI tar and complete ZIP bytes |
| `created_at`, `expires_at` | UTC `Z`, valid now, at most 7 days apart |
| `ticket_record` | Parent ticket comment/document URL containing the pre-push evidence |
| `assets` | Ordered `{id, size, sha256}` draft-release asset parts; positive numeric IDs, no duplicates |
| `reports` | Exactly `sbom`, `provenance`, `notices`, `secrets`, `vulnerabilities`, `smoke`, `source`, `review`; each `{file: KIND.json, sha256}` |
| `attachments` | Map of flat raw attachment filenames to SHA256 |

Every report has `schema_version: 1` (smoke requires `2`), `kind`, `status: pass`, `source_commit`,
`manifest_digest`, `observed_at` and nonempty `raw` attachment references. Reports
must predate the record and be at most seven days old at verification. A missing
field fails closed. Hashes cover **raw bytes**, not reformatted JSON.

Additional per-report fields:

- **sbom:** `format` (`spdx-json`/`cyclonedx-json`), positive `components`. Native
  Syft JSON must identify the archive/source and scanner/schema in raw evidence.
- **provenance:** `builder`, `build_without_package_write: true`,
  `archive_sha256`, `config_digest`, `upstream_revision`. Include build inputs,
  source/build log, builder settings and mandatory raw attestation statements.
- **source:** `accepted_commit`, matching SHA256 `built_inputs_sha256` and
  `accepted_inputs_sha256`, with both inventories in raw evidence.
- **notices:** `disclosures` contains the 12 accepted residual identifiers shown
  in the example, each with its actual continuing limitation or documented
  resolution. `corresponding_source` has `status: fulfilled`, nonempty `raw`, and
  `components: [{component, status: delivered|offered, evidence: RAW_FILENAME}]`.
  Review must reconcile the complete actual copyleft inventory; a sample or a
  metadata-only source map is insufficient. An offer must actually be legally
  sufficient and accessible to recipients; source-lock metadata is not delivery.
- **secrets:** `scanner: {name, version, ruleset}`, `content_scan: true`,
  `filesystem: pass`, `config_history: pass`, `deleted_contents: true`,
  `findings: 0`, `errors: []`, `layers: {BLOB_DIGEST: pass}` for every image and
  attestation layer. Native redacted results retain path/rule/hash, never values.
- **vulnerabilities:** `scanner: {name, version}`, `database: {digest, schema,
  updated_at}`, `input: oci-archive`, `archive_sha256`, `errors: []`,
  `unresolved: 0`, `disposition: clean|reviewed-exceptions`. Database is at most
  two days old at verification. For exceptions, nonempty `exceptions` entries
  require `id`, `reason`, `approved_by`, `expires_at` (valid through record expiry).
  Attach native Grype output and disposition rows with id/severity/fix state,
  package/location, installed-vs-lock-only, and decision. Review checks completeness.
- **smoke:** schema **2**, with exactly 13 assertions (credential isolation and
  provider-dependent second-box recall are separate). See
  [the strict smoke contract](hermes-smoke-schema.md). Native execution alone
  cannot qualify provider fixtures. Every exercised dependency must be real;
  component evidence uses a separate validator and never satisfies promotion.
- **review:** `commit` equals `accepted_commit`, distinct nonempty `author` and
  `reviewer`, `decision: approved`, `ci: success`, raw exact-head review evidence.
  Online GitHub check validation is additional to this recorded evidence.

## Publication and failures

A fixed concurrency group serializes qualification and publication for this
repository. Keep this workflow the only registry publisher: GHCR has no atomic
compare-and-set tag creation, so an unrelated external publisher can race a
check. Restrict package-write access operationally; this implementation makes no
repository/package/access setting changes.

Both `sha-FULL_BUILD_COMMIT` and `vX.Y.Z` must be absent before any copy; each is
checked again immediately before use. The lookup advertises OCI image/index and Docker manifest/list media types. Only
authenticated registry 404 responses with canonical `MANIFEST_UNKNOWN` /
`manifest unknown` or `NAME_UNKNOWN` / `repository name not known to registry`
messages and absent or matching-tag detail count as absence. Negotiation errors
and unknown response shapes fail closed. Authentication,
network, rate-limit or server failures stop publication. Existing tags always
fail, even if their digest matches. The workflow uses
[`skopeo copy --all --preserve-digests`](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md)
from the archive, without rebuilding or conversion. Its returned digest must
match the record. Tokens stay in a mode-0600 auth file and never enter command
arguments or image content. The file is cleared after the attempt.

The job then copies **all blobs anonymously by root digest**, and hashes the raw
anonymous manifest for each tag. The step summary records index/platform/config
identities, tags, attempted/published tag lists, and anonymous pull status. A
partial write, mismatched returned digest or anonymous failure is a failed
release, not success. There is no automatic retry/overwrite/delete/rollback of
registry state: preserve the receipt and route the partial release to the parent
owner. A rerun refuses existing tags and requires an explicit reviewed recovery.

No mutable `latest` tag and no deployment hook are created. After a successful
parent-owned publication, hand the digest and rollout/rollback notes to Opi for
the separately authorized LAN canary. Source rollback is a normal revert PR.
Operational rollback selects a previously accepted digest/config and preserves
volumes; production, data deletion or shared-data changes retain their own gates.

## Validation

`python3 -B -m unittest discover -s apps/agent-box-hermes/test -p promotion_test.py`
uses synthetic byte graphs and fake registry/network responses only. The project
suite includes it automatically. Live publication is intentionally not performed
by this implementation task. Read-only qualification of a real candidate waits
for its reviewed evidence record; none is included in this PR.
