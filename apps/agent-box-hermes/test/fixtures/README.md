# Hermes editable finder regression (HEX-206)

`hermes-editable-finder.py.gz` contains the unmodified 192,492-byte generated
setuptools finder extracted read-only from the pinned linux/amd64 base image:

- Image: `nousresearch/hermes-agent:v2026.8.18@sha256:22e37bb4ed1b0f50cb6bd991dca7ecacd6c9f29df9b4a20fc989d32bc763ccf6`
- Compressed source layer: `sha256:c8c00fe04e525a48182f2328ede66d06c49b3a49d3c6ecea7c9607038fa7d5e2`
- Member: `opt/hermes/.venv/lib/python3.13/site-packages/__editable___hermes_agent_0_20_4_finder.py`
- Uncompressed SHA-256: `d742cfb3c9791162c7bf9a8a4f359f321da8efb5e2ab3aad5ee17d59815423d3`

Extraction verified the registry layer digest before reading the tar member.
The fixture uses deterministic gzip (mtime 0) to keep the generated namespace
table compact. Inspect with `gzip -dc hermes-editable-finder.py.gz`. Tests parse
it as data and never execute its import hooks. No Photon package code is included.
The setuptools template's MIT permission notice is retained in
`setuptools-LICENSE` (source: https://github.com/pypa/setuptools/blob/main/LICENSE).

All six occurrences of `@photon-ai/slack` are literal namespace search paths
in the top-level `NAMESPACES` dictionary. Their suffixes are the package root,
`proto`, `dist`, `proto/photon`, `proto/photon/slack`, and
`proto/photon/slack/v1`. Setuptools namespace discovery walked the sidecar's
node_modules tree. The generic finder registers lazy Python namespace search
locations; it does not load this JavaScript package. After package exclusion,
these locations point to absent directories.

The sanitizer accepts this **exact path and normalized complete-file digest**, recording
it separately from executable importers. Only literal NAMESPACES key order/format is normalized; all other byte drift (including altered
import-hook behavior without a new Slack literal), appended imports, alternate
paths, and other unexpected importers still fail before filesystem mutation.
A base-image update requires inspecting the new finder, updating this fixture
and its reviewed digest, and repeating the image/import checks. This is not a
filename, site-packages, Python-string, or NAMESPACES blanket exemption.

Hindsight 0.8.3 migration fixtures are unmodified files from the SHA256-pinned
`hindsight-api-slim` wheel in `build/hindsight-linux-amd64.lock`, gzip-compressed
with mtime 0. Their distribution license is retained in
`docs/third-party/hex214-security-inputs/`.

## Rebuilt finder (HEX-225 / HEX-227)

`hermes-rebuilt-editable-finder.py.gz` is the unmodified pre-sanitizer capture
from source `f268f6ae02e312871bd0a5071224ec69dc5a6dad`, using the same pinned
base and setuptools 83.0.0 from the hash-locked build tools. Opi captured it
on drone with the tracked Dockerfile prefix through the sanitizer COPY;
no finder code was executed for comparison.

- Evidence: /HEX/issues/HEX-227
- Uncompressed size: 192,492 bytes
- Uncompressed SHA256: `73c39a284e629bf22cca4a6fb7c95c0aa9724800ab20a9346823c8b51cb1fb46`
- Gzip SHA256: `a9a3506bf059f1402c477160b492b57ef791b4512539773feb24ba472afa6499`

Only insertion order of the 981 NAMESPACES keys differs from the base fixture.
The sanitizer parses that single-line literal dictionary as data, rejects
duplicate keys and nonliteral expressions, serializes its keys in sorted order
while preserving list order, and hashes that replacement plus every other
original byte. Both fixtures produce
`80860416113ee72341ac431359c9855657c6f765876add38f7b4ff8e7aab40a6`.
Actual unnormalized SHA256 remains in the sanitation report. Keys, values,
import hooks, surrounding source and exact installed path remain guarded.
