# Mandatory candidate license/notices presence gate

The publisher checks the exact OCI archive it will upload, both in the workflow
before offline smoke and again inside `publish.py` before any registry copy.
Secret scanning and offline smoke remain mandatory; only SBOM and vulnerability
reporting may fail without stopping the workflow.

Required regular, nonempty, non-whitespace files in the final image filesystem:

- `/usr/share/doc/agent-box-hermes/LICENSE`
- `/usr/share/doc/agent-box-hermes/THIRD-PARTY-NOTICES`

The gate verifies referenced SHA256 blobs, applies OCI whiteouts/opaque directory
removals, and checks later replacements, including duplicate same-layer entries.
Directories, links, and devices invalidate previously captured required files;
non-directory ancestors fail conservatively even if replaced in a later layer.
It never extracts or executes image content. It accepts a single-platform OCI
archive and requires its revision label to match the full workflow source SHA.
The publisher also compares the checked manifest digest with the manifest skopeo
will copy. A report from another candidate cannot authorize a push.

`license-summary.json` records the manifest digest, workflow SHA, built source
SHA, and sizes/hashes of the required files. Both SHA fields currently must be
identical. Preserve this report with the mandatory secret scan and smoke results
before publication. Workflow failure still prevents a push even if an older
report exists. Presence does not establish complete license compliance.

## Packaging and release evidence

The backend-box Dockerfile copies the repository MIT license and assembled
upstream attribution texts into the required paths. `licenses/sources.json`
records their source refs and SHA256 hashes; `licenses/assemble.py --check`
validates the text inputs, assembly, and root LICENSE copy before building.
These inputs came from backend-box inspection under HEX-425, not the historical
`apps/agent-box-hermes` notice tree. No placeholder notices are included.

The inspected predecessor was manifest
`sha256:22cbf26f780c11c1bf2b84c1f103599af08de3bd849f988d51c24732f50e275b`,
source `ae73247`. Both delivery paths were absent. That inspection is diagnostic,
not acceptance evidence for the new build. Some upstream installers and buzz
float; static-binary transitive notices are not fully covered by these top-level
texts. Independent review must assess these documented limits and the actual
new candidate contents. Presence does not establish redistribution rights.

Mindi explicitly reconciled source on HEX-421: the repair merge SHA replaces
`5fbe93227bdfc52968b034b1eb3c4a403766e18a` as both workflow and build source,
with that UID fix as an ancestor. After independent exact-head approval and green
CI, record the exact merge SHA on HEX-422. Devi must revalidate gate ordering
before the separately owned release dispatch. No publication or deployment is
part of this repair task.

## Validation

```sh
python3 -B -m unittest discover -s scripts/hermes-release -p 'test_*.py' -v
python3 -B -m unittest discover -s apps/agent-box/test -p 'test_*.py' -v
pnpm build
pnpm lint
```

Synthetic tests cover missing/empty/whitespace files, symlinks/hardlinks, deleted
or overwritten documents, opaque directories, corrupt blobs, unsafe paths, source
mismatch, mismatched publication manifests, mandatory workflow ordering, and a
valid publication with recorded candidate identity. Fixtures are test data only.
A real candidate build, inspection and smoke remain required on a Docker host.
Rollback is a reviewed source revert; never publish a candidate after removing a
mandatory gate. Existing registry tags and runtime data remain untouched.
