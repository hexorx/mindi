# Private Hermes release

The simplified release supersedes the qualification program, paid-provider
windows, D1–D6 batch and b02a240c ticket-record verifier. Historical scripts and
records remain as evidence, but are not invoked by the release workflow.
The 1812-row vulnerability disposition is not reopened.

Opi runs **Hermes private subscription release** from merged `main` after Neti
has approved the exact PR head and its CI has passed. The workflow builds once,
checks every image layer (including subsequently deleted files) and config/history
for secrets, starts the container and desktop, obtains a real Codex subscription
answer, and pushes that exact artifact to `ghcr.io/hexorx/agent-box-hermes`.
SBOM and vulnerability reports are informational artifacts; scanner errors there
do not block publication. Secret scanner errors and unreviewed findings do block.
Existing reviewed non-secret fixture exceptions match path, file SHA256, rule and
line; changed bytes cannot inherit an exception just because the path is the same.
No vulnerability-disposition or ticket-record gate is consulted.

## Subscription setup

Use the existing subscription, not an OpenAI API key. Follow the
[box login instructions](../apps/agent-box-hermes/README.md#subscription-login):

```sh
docker exec -it --user 1000:1000 BOX /opt/hermes/.venv/bin/hermes auth add openai-codex --type oauth --no-browser
```

For the manually dispatched workflow, Opi makes the existing **box-specific**
Hermes OAuth `auth.json` available as the repository Actions secret
`HERMES_SUBSCRIPTION_AUTH_JSON`. This is a subscription credential, not a new
provider/API key. It is exposed only to the readiness check and subscription
smoke step, never to the build or image save. It is passed by stdin to a private
file in the test container. Do not attach or print it. The smoke emits only
pass/fail and requires the exact random challenge response with
`--provider openai-codex`; no mock or API-key fallback can satisfy it.
Expired/revoked credentials block the release until Opi restores the login.
OAuth refresh inside the disposable smoke is not exported; provision a dedicated
login for CI and refresh the Actions secret when needed.

## Private package and immutable identity

The workflow uses `GITHUB_TOKEN` with `packages: write`. Existing package metadata
must report `private`; public/internal packages are refused without changing their
visibility. A new GHCR package is private by default ([GitHub documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pushing-container-images)).
A 404 can create a new package; other metadata errors fail closed. Existing private
packages must grant this repository Actions access.

The only pushed tag is `sha-<full-source-commit>`. Existing tags are refused both
before building and immediately before pushing, with one concurrency group for
all workflow releases. Do not push manually in parallel: GHCR tags are mutable at
the registry level; the refusal is enforced by this publisher. `skopeo` preserves
the OCI manifest digest and verifies it after upload. `receipt.json` records the
full `ghcr.io/hexorx/agent-box-hermes@sha256:...` deployment reference and private
visibility. Deploy only by that digest. No `latest` tag is written.

If upload succeeds but verification fails, the receipt stays `prepared`: Opi
must inspect the existing tag/digest rather than overwrite it or declare success.
No release record, paid test window, Josh approval batch or public package is
required. The workflow does not deploy anything.

## Memory, rollout and rollback

The release ships built-in file memory in the persistent home. Hindsight semantic
recall is unavailable; no paid embeddings or memory LLM key is used. Existing
Hindsight data is preserved without database startup or migration.

Opi builds/smokes/publishes under [HEX-97](/HEX/issues/HEX-97). Use a fresh home for
the LAN test box, log in with its subscription, and retain the prior image/config
and volumes. Roll back by restoring the prior digest and its corresponding saved
volumes, without overwriting current data. Do not delete the frozen b9e211a2 image.
Production deployment, public exposure, tailnet ACL changes and paid API calls are
outside this release task.
