# Final image reconciliation

Collect evidence from the exact Git head and image digest under review. Run
`scripts/release/collect_inventory.py` with every installed Python interpreter
(system, Hermes, Hindsight); include `--include-debian` once. Record interpreter
versions. Scan the **final filesystem** with Syft JSON and retain the tool
version/configuration and unsupported coverage. Do not use an all-layer SBOM as
proof of installed membership. Keep raw SBOM rows even when they describe
historical evidence; classify those separately rather than editing the scan.

Against an exported final filesystem, run the read-only overlay generator:

```sh
python3 scripts/release/reconcile_final_inventory.py \
  --root exported-root --sbom final.syft.json \
  --inventory system.json --inventory hermes.json --inventory hindsight.json \
  --source-head FULL_GIT_HEAD --image sha256:IMAGE_DIGEST \
  --output final-notice-overlay.json
```

The overlay validates shipped baseline notice hashes and retains each original
row's `source_status`. It links final artifact identities, installed environment
identities, historical notice references and prior disposition row numbers.
Cargo metadata/lock supersets stay candidate-only. Excluded Photon providers in
the final SBOM fail the join, except records located solely in historical
notice/evidence files. Modified SDK/wrappers/fonts are labelled; the build's
sanitizer report supplies the concrete file mutations. Cache deletion and
Playwright relocation do not rewrite old rows.

The generated output deliberately remains incomplete until Codi and Devi review
all `needs-membership-review` and `needs-disposition` entries. In particular,
confirm Hermes/s6/embedded pg0/native binaries using final hashes and the
retained source evidence, not guessed version membership. Add a separate
reviewed disposition overlay; never rewrite the historical records to make a
validator green. Accepted declared-only/native/build-source limitations remain
known limitations, not closed source obligations.

Opi's HEX-207 handoff must include the 20 new Debian packages' exact source
versions, signed Sources/.dsc identities, retained archive/patch checksums and
accessible artifact references. Reconcile these to installed versions and the
21 build-collected `debian-replacements/` notice records. Copyright presence or
a snapshot link alone is not retained corresponding-source evidence. Preserve
Chromium, openh264 and Debian FFmpeg obligations and any build-recipe residuals.

Also retain final npm package.json identities/paths and lock/resolved/integrity
associations, workspace/private packages, final file/layer indexes, all-layer
payload absence checks, restored historical-log hashes, disabled Slack/WhatsApp
and supported Photon import smokes. Keep raw config FAIL with the intentional
PATH explanation; observed ArgsEscaped=true must not be reported absent.

Codi integrates and reviews these evidence artifacts, then requests independent
exact-head full acceptance. Green CI and a clean build alone do not close the
reconciliation. HEX-181 retains the operator hold after acceptance; no merge,
publication, deployment or HEX-97 continuation is authorized.
