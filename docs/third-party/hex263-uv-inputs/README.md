# uv 0.12.21 shipped notices

This directory is copied into `/usr/share/doc/agent-box-hermes/third-party/hex263-uv-inputs`.
`THIRD-PARTY-NOTICES-uv.txt` is the combined notice; `crates/` retains every upstream
file byte-for-byte. `spdx/` contains **supplemental SPDX license text, not upstream
notice text**. Cargo.toml authors are metadata, not copyright-holder assertions.
priority-queue 2.7.0 is distributed under MPL-2.0.

## Verified inputs

Both attachment digests and every internal SHA256SUMS entry were verified before use:

| Input | SHA256 |
| --- | --- |
| HEX-256 v1 bundle (c4327c36-87fc-4a44-8a04-1c13e60f6d51) | `c7ebaf623e399facd436783a24c1b1974d315de183a49b5e33acc0560a101f32` |
| v1 notice (e37bf10e-0046-4109-9bb1-bdc82e32077b) | `6afac6a9c0ed7ffe2a8ad82b26df0bfc1d72ce14ce20bced40cbf2ca8b4f3bf8` |
| HEX-256 v2 bundle (20238501-9412-4d36-aca2-884c1960e187) | `b84b079456092c3936f1a6099ab41dd84196e2d898ead24a58416724d7411eb9` |
| v2 notice (f7db49de-5e4f-477c-ba91-c99c3bd9ffe2) | `711c490f3dc203fb3b41832b7e4070b45797e2905f04fec1a9cd5401fde33569` |
| v2 original manifest | `1a90be00127e2018dc0a36610f1be13cb135b47e4878e1bbebe90dddfc503ecd` |
| uv linux x86_64 GNU archive (Dockerfile pin) | `23f02075b652bb1df64178cfae41b5caf160822e720e2663568f3f5d63bc52c0` |

Integration uses v2. All upstream files are identical to v1. `manifest.json` adds
an exact first-party workspace allowlist and supplemental text hashes. The eleven
exact-version/checksum decisions in `dispositions.json` transcribe Mindi's
HEX-256 license-disposition revision `ab98adbd-18b1-429b-b11a-41c46f070d99`.

## Coverage and regeneration

CI checks the recorded closure and notice bytes. The Docker build additionally
extracts `.dep-v0` from **both installed binaries**, without executing them, and
rejects missing notices, stale dispositions, altered upstream files, or a changed
closure. ELF64 little-endian is intentional: this image pins linux/amd64 uv.

The original decompressed JSON hashes to
`3e78411e90e47281dac46058f9bc4ba0c7949488d6e917d9546543763ac0063d`.
Its parsed contents equal the approved evidence. Serializing with Python
`json.dumps(data, indent=2, sort_keys=True) + '\n'` yields the evidence hash
`0e37a3ed6a62474089738cc1232f243229d9b69587e4bd1b959d61196b0e5bf9`
for both uv and uvx. The check uses this deterministic representation so whitespace
and object-key ordering do not masquerade as a closure change.

Run from the repository root:

```sh
python3 apps/agent-box-hermes/build/verify_uv_notices.py docs/third-party/hex263-uv-inputs
python3 apps/agent-box-hermes/build/verify_uv_notices.py docs/third-party/hex263-uv-inputs --bin-dir /usr/local/bin
python3 -B -m unittest discover -s apps/agent-box-hermes/test -p uv_notices_test.py
```

For a changed HEX-246 closure, regenerate the crate notices and dependency evidence
from the new binaries and matching Cargo.lock. Send any new declared-only crate to
Mindi for an exact-version/checksum disposition before updating this guard.
The combined file can be regenerated with `render()` from the verifier; it copies
upstream bytes directly and supplies integration labels around them.

This integration does not fulfill HEX-97 corresponding_source or replace Neti's
final reconciliation. No publishing or deployment is part of this change.
Rollback: revert the integration commit and rebuild a distinct candidate; preserve
existing qualification evidence and resources.
