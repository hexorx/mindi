# Five High dependency rows: source remediation

This change targets the installed packages reported on image c589d242. It does
not claim a clean rebuilt image or a not-affected verdict based on LAN access.

| Installed tree | Before | After | Primary advisory |
| --- | --- | --- | --- |
| `/opt/hermes/.venv` urllib3 | 2.7.0 | 2.8.0 | [chunk-size bound](https://github.com/urllib3/urllib3/security/advisories/GHSA-vxq7-64xx-v4gw), [proxy TLS separation](https://github.com/urllib3/urllib3/security/advisories/GHSA-8988-9cw3-xx77) |
| `/opt/hermes/.venv` tornado | 6.5.8 | 6.5.9 | [static symlinks](https://github.com/tornadoweb/tornado/security/advisories/GHSA-c2m8-h5v5-343r), [curl response limit](https://github.com/tornadoweb/tornado/security/advisories/GHSA-chx6-46f5-w4vp) |
| `/opt/hermes/plugins/platforms/photon/sidecar/node_modules/@grpc/grpc-js` | 1.14.4 | 1.14.5 | [unauthorized certificate auth context](https://github.com/grpc/grpc-node/security/advisories/GHSA-m9gg-hp2v-232j) |

Advisories checked 2026-10-01. Their patched versions match the table. urllib3
requires Python >=3.10; Tornado requires >=3.9; the inherited runtime is 3.13.
The two grpc-js releases declare identical dependencies (`@grpc/proto-loader`
^0.8.0 and `@js-sdsl/ordered-map` ^4.4.2). The image's Node verifier checks their
actual inherited resolution and engine bounds, then loads grpc-js and creates
and closes an offline client without connecting.

The full Python lock was regenerated with uv 0.12.21 using the existing lock
and targeted upgrades; only these two package versions changed. The existing
exclude-newer cutoff remains intact. The narrow installed overlay uses verified
wheel SHA256s; the complete lock retains all platform artifacts. Runtime
assertions require both exact patched versions. Offline regression probes
exercise ordinary and oversized urllib3 chunk-size lines and Tornado safe-file
and escaping-symlink handling during image assembly.

The immutable Hermes base supplies photon; there is no fresh sidecar npm install
in current main. `hermes-node-security.json` is the installed-tree overlay lock.
It validates the inherited grpc-js identity/version before applying verified
1.14.5 archive bytes, preserving nested dependencies. This does not modify only
a global CLI tree. Upstream base package-lock files remain historical inputs,
as in the existing overlay workflow; the overlay lock describes shipped bytes.

`third-party/hex290-security-inputs` records registry integrity, archive SHA256s,
license bytes and their hashes. These inputs and the regression probe are
included in the restricted Docker context. Existing source evidence is retained.

Validation passed: project build, lint, typecheck, all 10 test tasks (including
313 Hermes Python tests; nginx supplied from the verified project APT lock); targeted
`uv lock --check`; hash-enforced wheel installation and offline P9 probes.
The runner has no Docker, so full OCI build and real inherited-tree checks are
mandatory in Opi's single combined LAN rebuild under HEX-292, coordinated with
HEX-279. Source approval and exact-head green CI precede merge.

Rebuilt bytes require fresh archive/index/platform/config pins, native security
and secret scans, reviewed secret pin updates, and regenerated companion,
SBOM/notices/provenance. Existing c589d242 secret pins are evidence only for those
old bytes. Keep the secret gate and exact-pin workflow. Retain existing archives;
rollback is a reviewed source revert followed by the controlled LAN rebuild.
No publication, production deployment, spend, or data cleanup is part of this PR.
