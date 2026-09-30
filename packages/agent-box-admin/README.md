# Resumable roster registration

Node 24 CLI for registering an **existing** Hermes box through Paperclip's
approval-aware `agent-hires` endpoint. No deployment, box configuration writes,
status activation, callback-key creation, smoke wakes, or cleanup are performed.
`registered` means the mapping exists and the agent is active/idle/running; it
is not a claim that a smoke wake or full desktop/memory qualification passed.

Build from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @mindi/agent-box-admin... build
node packages/agent-box-admin/dist/cli.js register --request registration.json --dry-run
node packages/agent-box-admin/dist/cli.js register --request registration.json --state /operator/roster-state
node packages/agent-box-admin/dist/cli.js reconcile --request registration.json --state /operator/roster-state
```

Use an agent-scoped `PAPERCLIP_API_KEY` with hiring, agent-read and adapter-test
permissions. `PAPERCLIP_API_URL` must be HTTPS and may end in `/api`.
`PAPERCLIP_RUN_ID`, when provided, is attached to Paperclip requests for auditing.
Bind the existing box API credential to `AGENT_BOX_CREDENTIAL_box_key` through
the operator's secret mechanism. Never put the value in the request or command
line. `apiSecretId` is the existing **same-company Paperclip secret UUID** for
that credential. Paperclip resolves and validates this reference during the
adapter environment check and hire. The symbolic roster reference is used only
for the operator-side authenticated probe.

Example `registration.json` (replace IDs and digest with real, verified values):

```json
{
  "companyId": "10000000-0000-4000-8000-000000000001",
  "name": "helper",
  "role": "engineer",
  "reportsTo": "10000000-0000-4000-8000-000000000002",
  "sourceIssueId": "10000000-0000-4000-8000-000000000003",
  "budgetMonthlyCents": 0,
  "apiSecretId": "10000000-0000-4000-8000-000000000004",
  "paperclipApiUrl": "https://paperclip.example",
  "box": {
    "boxId": "10000000-0000-4000-8000-000000000005",
    "flavor": "hermes",
    "endpoint": "https://helper.example/api",
    "imageDigest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "configRevision": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "apiCredentialRef": "box_key",
    "capabilities": ["desktop", "memory", "hermes-api"],
    "registration": null
  }
}
```

The request embeds one `RosterBoxSchema` entry selected from a verified roster.
JSON is the CLI input format. Unknown fields and inline credential fields are
rejected. The endpoint must name the actual shim API base (including `/api` if
needed); no automatic dashboard URL rewriting occurs. Obtain box ID, digest,
config revision and desktop/memory/network qualification from the deployment
record. The live `/health` endpoint proves API credential control and health;
it does **not** attest the supplied box ID, image digest or capabilities.

Dry-run validates input and reads `/agents/me` to verify company scope, then
renders the secret-reference-only hire payload. It does not create local state,
probe a box, reserve an operation, or call a POST endpoint. It is a preview,
not a successful connectivity or authorization check. Actual registration also
checks manager/source-issue company, server roster conflicts, authenticated box
health (unauthenticated access must return 401/403), and a passing Paperclip
adapter environment test. Warnings fail closed for operator investigation.

## Reservation boundary and recovery

All operators and **all companies** using this workflow must use the same
trusted local state directory on one host. Protect and back it up as operational
state. Do not use NFS, separate copies, or independent state paths: this is not a
distributed server-side lock. SQLite serializes workflows across processes,
uniquely reserves `(companyId, boxId)`, and additionally disallows reusing a box
ID or endpoint across companies. This cannot discover bindings created outside
this workflow in companies the caller cannot read. Import/transfer of such
bindings requires a separately reviewed ownership workflow; never bypass a
conflict by changing the box ID or state path.

The operation store commits a secret-free `uncertain` record **before** sending
one hire. A separate SQLite transaction holds the process reservation while
network requests run. OS process death releases that transaction; the durable
intent remains. Input fingerprints prevent a resume from silently changing the
manager, credential reference, endpoint, or hire parameters.

`reconcile` only lists/reads Paperclip and updates the local journal. It finds
matching operation metadata and reads the specific agent and approval. Pending
hires remain pending until the real approval and agent state change. Rejected
hires remain recorded; there is no automatic replacement or activation.

A timeout or ambiguous/malformed response is followed by list/read reconciliation.
An empty list never proves that an in-flight hire failed: the operation stays
`uncertain`, including across process restarts, and `register` will not POST
again. Repeat `reconcile` after server recovery. If no matching agent appears,
the operator must investigate the server audit trail; this version deliberately
has no force-retry/reset switch. Do not remove the reservation to retry.

The CLI returns exit 0 for a valid preview or known/reserved state, 2 for an
uncertain hire, and 1 for validation/access/probe/reservation failure. Inspect
`phase` for pending, rejected and inactive outcomes. Diagnostics and stored
errors use bounded codes, never raw HTTP bodies or credential values.

Rollback: stop using the command and revert the package change. Preserve the
state directory and existing agents/boxes. Agent transfer, deletion or other
compensating actions require a separate authorized workflow.
