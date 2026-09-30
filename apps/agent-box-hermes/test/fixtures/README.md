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

The sanitizer accepts this **exact path and complete file digest**, recording
it separately from executable importers. Any byte drift (including altered
import-hook behavior without a new Slack literal), appended imports, alternate
paths, and other unexpected importers still fail before filesystem mutation.
A base-image update requires inspecting the new finder, updating this fixture
and its reviewed digest, and repeating the image/import checks. This is not a
filename, site-packages, Python-string, or NAMESPACES blanket exemption.
