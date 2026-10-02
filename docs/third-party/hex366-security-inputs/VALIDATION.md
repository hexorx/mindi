# Local validation

- `pnpm install --frozen-lockfile --ignore-scripts`: PASS, lock unchanged.
- `pnpm build`: PASS, 5/5 tasks.
- `pnpm lint`: PASS, 5/5 tasks.
- `pnpm typecheck`: PASS, 7/7 tasks.
- `pnpm test --env-mode=loose`: PASS, 10/10 tasks including all 330 Hermes Python tests. The declared requirements-test.txt dependencies and a hash-verified extracted nginx binary were placed on PATH in isolated scratch directories. Initial attempts failed only because host Python lacked PyYAML/aiohttp and nginx was absent; the final full test command passed.
- `python3 -B -m unittest discover -s scripts/hermes-release -p 'test_*.py'`: PASS, 21 tests.
- Debian signed-index and binary/source checksum verification: PASS (15 binaries, 19 source artifacts).
- Read-only apt resolution from retained candidate inventory: PASS (15 upgrades, no additions/removals).
- npm installed dependency-range join: PASS (60 edges).
- `git diff --cached --check` excluding verbatim upstream `*-copyright` files: PASS. The unmodified upstream notices contain trailing whitespace; their original bytes are preserved.

No Docker executable is installed locally, so container build/runtime checks and exact-head GitHub CI have not run. Managed GitHub identity is unavailable; no PR or merge is claimed. F3 is complete under Mindi's approved overlay decision. No merge or candidate acceptance is claimed.

## F3 continuation validation

- Registry SHA512 and computed SHA256 for ip-address 10.7.1 / brace-expansion 5.0.12: PASS; archive metadata matches lock.
- Recursive npm-tree regression: PASS; missing packages and nested vulnerable copies of either package fail closed.
- Offline CLI smoke on inspected npm 12.2.0 archive with exact overlays: PASS (version, ls, pack). Build uses the actual inherited npm tree with network disabled; Docker is unavailable locally.
- Full test rerun: 10/10 tasks PASS, including 330 Hermes Python tests and the new Node regression. Build 5/5, lint 5/5, typecheck 7/7, release tests 21/21 PASS. Turbo reused unchanged task outputs.
- Initial smoke development caught shared config-path and npm 12 pack-output-shape assumptions; both corrected and smoke rerun passed.
- Initial suite runs lacked Python dependencies through Turbo and caught the missing Docker allowlist entry. Scratch dependencies were passed through with --env-mode=loose; the allowlist was fixed and the full suite passed.
- Host prerequisites remained isolated in run scratch: pinned requirements-test.txt dependencies, pip wheel checked against PyPI SHA256, and nginx archive checked against the repository lock.
