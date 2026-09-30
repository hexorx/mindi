# HEX-189 reconciliation update — closure remains incomplete

Additive review artifact for Codi under HEX-181, targeting `hex-181-dependency-locks`. Integrate beside the existing `hex189-supplement`, preserving the original supplement and `hex184-resolution/bundle`. This update supersedes the original supplement only for the explicit evidence associations and corrections below. No product repository, Dockerfile, lock, extraction boundary, image or deployment changed. Rollback: omit this update or normally revert its eventual integration commit.

Subject: source `2a74043e8d639de3547d517f5b31665a83c4ec43`; image `sha256:3819c0400a46d16ed3307ac3caa419a669ac91b1c9490998335773d76e35731f`.

## Inputs and trust

- HEX-190 evidence attachment `1c1e99a3-0be1-4161-b4eb-13e6116e1aaf`: SHA256 `606dc2fcb095f8e8670f45b029aac0413c1da55ed7c14634ad1036ee675765cb`. Independently verified archive digest and all 81 internal manifest entries. Selected evidence files are reproduced unmodified under `source-evidence/`; Opi produced the image observations. Devi did not rerun the image analysis.
- HEX-191 grant attachment `3242cbd7-b366-46d0-89d4-6de793fe8bad`: SHA256 `539e60ce851aa447bc016662114f55aa557622920be1fe77f47d742862fd9001`. Independently verified archive digest, all 26 internal manifest entries and all 44 text references (including original supplement references). Original research and its limitations remain under `grant-evidence/`. Cari’s upstream-history/source-match conclusions are attributed research, not an independently repeated history audit.
- Three retained archives independently downloaded from the LAN evidence service and checked against Opi’s volume manifest: cua `039783f9221a08c0daf9cda65a460fc4f346fa6e` SHA256 `c63c7e04b22209469e529c89220bf77f10db9722800e9ff2ab4f71b8ba7057e6`; Hermes `e624e9fde561e1add9388384012b295fde669ade` SHA256 `60abc6fc064449fd596286dae20b1c105ad6aeb0d97d3036d950bef65a59af55`; tailscale/go `7275f792d406d3c386cc807937a45a4a7b699d42` SHA256 `78f69df4d091ec316d4cfcb5ec2c1cb32be199b7bc36da9dc1d8dd7dedb98f28`. Original source URLs and retrieval trust are in Opi’s upstream evidence. Matching retained hashes does not upgrade TOFU retrieval to an upstream signed identity.

## Reconciliation results

`overlay.json` covers all 4,164 original rows by immutable baseline index, kind, name and version. Original statuses and membership fields remain unchanged. This is an evidence join, not a blanket source closure migration. `residual-review.json` preserves all 60 earlier residual rows and their new evidence associations. See `summary.json` for generated counts.

- 44 baseline rows join Cari’s 40 grant research entries; duplicate environments/binaries explain overlapping counts. Exact source-matched winapi and difflib notice bytes are supplied. Difflib’s anomalous holder line is retained verbatim. Tag-bound and post-release findings retain those qualifications. In particular seahash and six other matched rows are **post-release evidence**, not exact-release closure. Do not treat the researcher’s `resolved_*` prefix as shipping approval or complete closure.
- 1,648 baseline missing-notice rows join Opi’s source locator by ecosystem, name, version, environment and location. A locator naming a nested license does not prove applicability; none is automatically promoted to a package-root grant.
- 764/802 npm rows join the installed-package inventory by exact path/name/version. 620 have corresponding installed lock evidence; inspect each lock row’s status, integrity and differences. An additional eight Hermes workspace rows have independently verified source package.json hashes identical to Opi’s final-file manifest. Remaining 30 rows have no direct installed-inventory/workspace-byte join in this update; they are **not excluded**. Opi’s squashed/all-layer analysis reports npm name/version equality, but is not a substitute for a path-specific integrity proof. System npm packages, noVNC and fixtures remain represented.
- All eight Hermes workspace declarations at the retained commit match the final image byte-for-byte. The root MIT notice hash is `821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6`. Association covers workspace source, not nested dependencies, fonts or native payloads.
- All 15 cua local crates match the retained workspace’s names/versions and root MIT notice. The workspace declaration and per-package manifests are retained. The source-lock superset label remains: source membership and notice applicability do not establish runtime linkage. The separate test-corpus notice is not substituted for the root grant.
- `beep-boop` is located under `github-from-package/example/package.json`; its standalone-package classification is corrected to a containing-package fixture, retaining the baseline row.
- **Reject** the old registry `web@0.0.0` record as unrelated to `/opt/hermes/web`. The overlay records the exact rejected record path. Do not import it as workspace evidence.
- The exact Tailscale Go fork root LICENSE is now retained in `scope-bytes/`, with source archive provenance in `workspace-scope.json`. Generic official Go release text alone does not establish the fork’s identity.

`workspace-scope.json` contains 24 scope records: 15 cua, eight Hermes and the Go fork. `scope-bytes/` holds original bytes for root notices and package/workspace declarations. `text-references.json` resolves the imported grant texts. No copyright holders are invented.

## Remaining decisions and engineering limits

Mindi owns the batched remediation disposition: pg0/pg0-embedded and cobble remain without project-root grants; cobble’s inflection MIT notice covers that vendored file only. Remaining declared-only npm rows are listed in `grant-evidence/hex191-grant-triage.json`. No standard SPDX template has been substituted for an upstream grant.

Mindi must also assign disposition for gsap 3.15.0 proprietary terms, Photon packages (especially whatsapp-business with no license declaration), Nous UI and its undocumented bundled fonts, and the proprietary `claude-agent-sdk` bundled Claude binary identified by Opi. Cari’s recommendations are research, not authorization. Any dependency removal/replacement or declared-only shipping choice needs an explicit recorded disposition; actions on Josh’s stop list still need the appropriate batched gate. No new public/source visibility gate is requested.

Engineering limits remain as recorded in Opi’s summary: private FFmpeg recipe/static runtime identities, Chrome build configuration, manylinux vendored-library exact sources, s6 musl toolchain identity, cua/pg0 linkage bounds, native bindings/esbuild audit gaps, and TOFU source identity. Docker’s UNKNOWN Go main-module row still lacks a direct package-ownership join in this update; the baseline has Debian docker-cli 26.1.5+dfsg1-9+b13 / source docker.io 26.1.5+dfsg1-9 and its copyright notice, but that candidate must not be silently substituted for file-ownership proof.

These limitations and the 30 unmatched npm path rows need a concrete engineering disposition under Mindi/Codi before full closure. No release-readiness claim is made.

## Verification and regeneration

Run `python3 verify_overlay.py ../hex189-supplement` and `sha256sum -c SHA256SUMS`. The verifier checks all original row identities and the pinned baseline reconciliation hash; grant-text hashes; source-scope text hashes/lengths; eight workspace final-file matches; preserved not_reconciled statuses and source-lock labels; and safeguards for pg0/cobble, seahash and the rejected web registry record.

To regenerate, unpack the two named input attachments under a scratch directory as `hex190/hex190-evidence` and `hex191/hex191-grant-triage`; place the three hash-verified retained source archives there. Run `workspace_scope.py SCRATCH BASE_SUPPLEMENT`, then `build_overlay.py BASE_SUPPLEMENT SCRATCH`. Regeneration requires Python 3.11+. Scripts only read source archives and write evidence; they do not execute package code.

No application code changed, so no application build/lint/test was run. Codi owns independent artifact verification and feature-PR integration; merge needs another agent’s recorded approval and green CI on the exact integration head.
