# Validation — source preparation, 2026-10-02

Passed:

- `sqv --verbose --keyring /usr/share/keyrings/debian-archive-keyring.gpg --output ... --cleartext InRelease`: both signatures valid. Recorded in `signature.json`; index sizes/hashes and all four binary plus seven source downloads verified.
- Isolated `apt-get -s` with retained status matching all 553 original inventory entries and the four exact local packages: four upgrades, zero new packages/removals (`resolver.json`). No install.
- `python3 -B -m unittest discover -s apps/agent-box-hermes/test -p '*lock_test.py' -v`: 27 tests pass, including negative installer gates and exact inventory/artifact scope.
- `python3 -B -m unittest discover -s scripts/hermes-release -p 'test_*.py'`: 21 tests pass.
- `pnpm install --frozen-lockfile`: succeeds with pnpm 12.6.0, 103 cached packages; no lockfile changes.
- `pnpm build`: 5 tasks pass (4 cached). TypeScript build only, no candidate image.
- `pnpm lint`: 5 tasks pass (4 cached).
- `pnpm typecheck`: 7 tasks pass (6 cached).
- `bash -n apps/agent-box-hermes/build/apt-install-locked.sh` and scoped `git diff --cached --check` excluding the two byte-preserved upstream Chromium copyright files: pass. The unscoped check reports four upstream trailing-whitespace lines; those copyright bytes intentionally remain unchanged.

Environment-limited checks:

- Full Python discovery initially ran 278 tests with eight import errors due to absent PyYAML/aiohttp. `pnpm test` likewise has 9/10 tasks pass; Hermes fails on those same missing test dependencies. These are not reported as a full-suite PASS.
- `python3 -m venv` cannot bootstrap pip because ensurepip is absent. Downloading pinned pip 25.3 into run-owned scratch to install the project's exact test requirements failed connecting to files.pythonhosted.org:443. No system package installation or dependency-version substitution was made.
- CI is not yet run: GitHub's installed connector can read this repository, but feature-branch creation at the exact built source returned `403 Resource not accessible by integration`. No remote branch, PR, review approval, green CI, merge, candidate build, deployment or publication is claimed.

Before handoff, publish the exact prepared commit to the named feature branch, open the focused PR, create Devi's exact-head review child, and obtain independent approval plus green source CI. The full test dependency installation already exists in CI. Opi's new-digest build and runtime checks remain gated and must not be inferred from these source checks.

Local commit creation also failed with `fatal: empty ident name (for <>) not allowed`; the Git launcher reports no managed GitHub identity for this run. The implementation is staged on the feature branch, anchored at the built source. A binary Git patch and its reconstructed tree identity are the durable handoff; a remediation commit SHA must be recorded only after an authorized identity creates it.
