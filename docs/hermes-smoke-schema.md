# Strict smoke evidence, schema 2

HEX-241 review and HEX-243 implement Mindi's strict real-provider decision.
`validate_smoke(report, manifest_digest, attachments)` in
`scripts/hermes-release/smoke.py` is pure: attachments are a mapping of flat raw
paths to bytes. It raises ValueError on invalid input and returns True only for
complete release evidence. `validate_component_smoke` accepts only explicitly
labelled component reports. There is no fixture allowlist, waiver, legacy
upgrade, or automatic relabelling. Neither validator authorizes spend or release.

All other gate checks remain: reviewed source, OCI blobs/provenance, exact image
subject, report/raw hashes, report age, vulnerability/source/secret dispositions,
independent approval, and exact-head CI. The smoke-only function cannot replace
that complete gate. Reviewers must inspect the bound original runtime/provider
records: hashes establish identity and consistency, not truth of observations.

## Report and assertion contract

The envelope fields are exactly `schema_version: 2`, `kind: smoke`, `status: pass`,
`source_commit`, `manifest_digest`, `observed_at` (UTC), `raw` (unique string list),
and `checks`. Every scope/key in `SCOPES` is required. Unknown keys fail.

Each check contains exactly:

- `status: pass`, `execution_path: native`, `evidence_class` equal to
  `release_qualification` or `component_integration` according to the validator.
- `scope` equal to the versioned scope for that assertion; `image_digest_tested`
  equal to the report/candidate root digest.
- `inference_spend: none` or a Paperclip approval URL, as before. The reviewer
  verifies the actual authorization; a URL is not permission to spend.
- `mocked_components`: an explicit unique string array equal to the inventory's
  exercised mock components, including transitive ones. Release requires empty.
- `dependencies`: exactly one row for native_gateway, compatibility, desktop,
  hindsight, pg0, llm, memory_extraction, and memory_embeddings. Each row has
  `component`, `state` (real/mock/not_exercised), nonempty `reason`, and `identity`.
  Real providers name `provider` and `model`; implementations name
  `implementation` and `version`; mocks bind `fixture: {path, sha256}`.
  Configured but unexercised fixtures may use a fixture identity with
  `state: not_exercised`; the reason must explain the unexercised boundary.
  Memory assertions require the full Hindsight/pg0/extraction/embedding chain;
  API assertions require the native gateway, compatibility layer and LLM.
  Mark any exercised auxiliary memory providers real/mock, never not_exercised.
- `config` and `evidence`, each `{path, sha256}`. Paths are flat `raw-*`
  attachments, present in `raw`, hashed over exact bytes. Fixture references have
  the same rules. Nothing is fetched or executed.

The bound config JSON contains exactly `assertion` and `dependencies`, matching
that check. It is the redacted per-assertion resolved configuration/dependency
inventory. Preserve original config/fixture files as additional hashed raw
attachments for review. The bound evidence JSON contains exactly `assertion`,
`config_sha256`, and `observations`. Export observations from retained raw traces;
include those original decoded streams, provider request-entry logs, volume and
memory probe logs in `raw`. Do not manufacture observations from a pass boolean.
The code's evaluators define the exact typed observation fields, and the unit
fixtures demonstrate their serialization (synthetic tests, never qualification).

## Evaluator requirements

- SSE: capture the decoded HTTP response body (`HTTPResponse.read/readline`,
  **never** `response.fp`). Parser handles CR/LF, comments, optional spaces and
  multiline data. Require nonempty ordered unique numeric IDs, a nonempty token
  event with an object payload and a nonempty string `delta`, and terminal
  run.completed. When payload `event` metadata is present it must match the SSE
  event field. Scalars, lists, missing/empty/non-string deltas fail; whitespace
  tokens remain valid. Replay must equal the entire recorded suffix
  after a known cursor, including data and terminal event; empty replay fails.
- Cancellation: first token before stop, running at stop, final cancelled and
  correlated provider connection abort within five seconds. Retain native run
  and provider connection observations. Reservation cancellation must have no
  provider request entries. Local closure does not establish billing cessation.
- Retry: client idempotency only, not provider 429/5xx resilience. Start the
  request-entry ledger before the initial request. Log and flush request ID,
  correlated run ID and timestamp **at entry**, before any response work. Include
  auxiliary calls. Snapshot before retry, send same key/body, reject a changed
  body with 409 idempotency_conflict, then drain for 5–30 seconds after the response
  while continuing to collect entries. Same run required; any new entry after
  retry starts fails, even if it completed before the retry response. Do not
  filter completion logs by response time. Retain the ledger through drain end.
- Memory: generate a fresh cryptographic nonce (at least 128 bits), retain it
  with at least two distractors, test an empty bank, then recreate with a fresh
  container name on the same memory volume and recall without retain/reseed.
  Require the nonce after recreation and absence in a distinct fresh B bank.
  This scope is Hindsight persistence, not Hermes memory-tool integration or
  backup restore. Those claims require additional versioned evidence.
- `second_box_credentials` covers credential/TLS/volume separation only;
  `second_box_recall` requires real provider-backed recall. Direct local checks
  bind their assertion name and outcome to their raw/config evidence.

## Preservation and regression

`test/fixtures/hex212-smoke-v1.json` is a byte-for-byte copy of the report in the
original HEX-212 archive (archive SHA256
`51d228da5e5414addb04f86b8bc5da3acc90937a878534e74ba52f7740f2e9bf`, report SHA256
`c9c067609fba6c73f0b17f0c7fceac7da6a882e90a27279c3eda27600e6c4f89`). Its native
fixture integration results remain historical evidence. Both the pure release
validator and the AST-extracted smoke gate reject it. The original archive and
reports are never rewritten; new qualification is a separate linked addendum.

Run offline regressions with `python3 -B -m unittest discover -s
apps/agent-box-hermes/test -p '*_test.py'`. No provider calls or publishing occurs.

## Follow-up real-provider window

One provider/model and embedding model, one exact digest, one LAN test window,
and a **proposed** US$1 ceiling. Before any approval request, enumerate current
rates, native auxiliary calls and Hindsight extraction/consolidation/embedding
fanout; derive a worst-case request/token envelope and implement an atomic
pre-call budget reservation. Deny unknown rates, exhausted budget and unbounded
fanout; no automatic refill. Reserve worst-case cost before each call, reconcile
actual usage conservatively, include cancelled calls. API output caps: 128 tokens
for completion, 256 for cancellation. A hard cap needs enforced input limits and
bounds on every auxiliary request too. If it cannot fit, revise the same batch.

Spending and publication/ghcr visibility go into the parent's single Josh batch;
this PR neither runs providers nor publishes or changes production.
