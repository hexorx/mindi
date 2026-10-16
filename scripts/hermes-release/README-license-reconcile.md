# Bound Tailscale license reconciliation

Run with Python 3.11 or later:

```sh
python3 -B scripts/hermes-release/license_reconcile.py syft.json upstream-cache.json pins.json output evidence.json
```

The output directory must exist. `evidence.json` maps exactly these six names to
file paths, relative to that JSON file (absolute paths also work):

```json
{
  "candidate_index": "image-index.json",
  "image_manifest": "manifest-linux-amd64.json",
  "source_tar": "tailscale-1.102.4.tar.gz",
  "go_mod": "go.mod",
  "go_sum": "go.sum",
  "source_closure": "hex303-tailscale-source-closure-5f0521ca4273.tar"
}
```

For candidate `sha256:5f0521ca42733e5ddd7e217660c95ce68b7fd9d207cdf070b9f9a06bcba4f123`,
use the raw OCI index and amd64 manifest retained in HEX-292 build identity
evidence, and the source archive, patched locks, and full 196,075,520-byte
reassembled source-closure tar retained in HEX-303. The source and locks are
also members of that tar under `hex303-tailscale-source-closure-5f0521ca4273/tailscale/`.
Do not reserialize JSON or repack archives: verification binds exact bytes.

Every file is hashed against reviewed constants in `TS_EVIDENCE`. User-supplied
hashes cannot override those constants. The index pins the known manifest;
the manifest pins the known config checked in the SBOM. The source archive
identifies the v1.102.4 source; full-file lock hashes include unlinked entries;
the closure hash binds the retained module archives and graph files previously
independently verified in HEX-304. This enforces that retained evidence package,
not a fresh rebuild or an independent OCI-to-source provenance proof. It does
not rehash the full OCI archive or original 3 GB companion.

Missing, unreadable, or mismatched evidence exits 2 before writing either output.
Existing outputs are untouched on a binding failure; callers must check the
exit status and must not mistake old output for a successful run. SBOM binary,
layer, build metadata and linked-dependency checks still apply.

The embedded web-client rows deliberately have an empty license,
`unclassified` class and `UNRESOLVED` disposition even when a cache, detected
license or source pin offers a permissive answer. Its complete composition,
inferred scheduler/classnames versions, and Inter version/candidate notice
remain unproven. Successful reconciliation (exit 0) only means a report was
produced; it does not grant publication clearance. The summary preserves these
unresolved rows and explicitly states that clearance was not granted.

Option A (notices as release assets) remains a proposed route. Notice
completeness and actual delivery, the stale image overlay, 11 NO_PUBKEY source
signatures, placeholder release IDs and FreeType credit requirements remain
release gates. Neither this tool nor the retained evidence authorizes publication.

Tests use small synthetic evidence bytes with test-only expected hash patches;
production pins are exercised by the separately recorded full-evidence replay.
