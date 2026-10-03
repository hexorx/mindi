# Original backend-box, subscription login

This is the layered source behind `mindi/backend-box:9a65870`, imported with only
subscription bootstrap, removal of baked SSH host-key generation and site-specific
documentation, and release plumbing. Dependency versions are unchanged.

`base/` contains the required inputs from `239cb02101c6172eabf94effb537e6f3558109b4`.
`backend/` contains the recovered build tree reported as
`9a65870f661cdb5adb017f8fda361927291b9310`; that Git object remains unresolved.
The inherited `c7f9549e` image label is not the producing base revision.
`source-manifest.json` records original SHA256 values; `source-changes.json`
records each edited imported file. This is a source reconstruction, not a claim
that a new build has the original image digest. Upstream recipes include floating
package downloads; they are deliberately retained.

Build from this directory (linux/amd64):

```sh
docker build -t agent-box-base:local -f base/infra/agent-box/Dockerfile base
docker build --build-arg AGENT_BOX_IMAGE=agent-box-base:local \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t agent-box:local -f backend/infra/backend-box/Dockerfile backend
```

Run `compose.yaml` with `AGENT_BOX_IMAGE` set to the published digest and
`BACKEND_TOKEN_FILE` pointing to an existing, nonempty operator token file outside
Git (at least 32 characters, readable by UID 1000). This is backend authentication,
not a model API key. The example restricts host access to loopback. The five
personas retain the original native desktop implementation. Enable a persona's
desktop through the authenticated backend desktop settings API/client.

## Log in with your subscription
1. Keep the named home volume mounted at `/home/agent`; use UID 1000 for login commands.
2. For Claude Code, run `docker compose exec --user 1000:1000 agent-box claude auth login` and choose the subscription account.
3. For Hermes, mount/copy your existing Codex subscription `auth.json` into `/home/agent/.hermes/auth.json` (owner 1000, mode 0600).
4. For native backend OMP conversations, use its own subscription login in `docker compose exec --user 1000:1000 agent-box omp`; preserve its home credential store too.
5. Restart with the same home volume; never put login files in a build context, image layer, Git, or CI output.

Hermes CLI uses the `openai-codex` subscription configuration reused from PR #41.
The original backend uses OMP for conversations and Claude ACP for delegation;
it does not launch the older Hermes gateway/bootstrap. These are separate native
credential stores; a Hermes login does not prove OMP or Claude login. API keys are
not required or passed by the example. Paid voice and Hindsight services are not
configured. Existing operator configuration is preserved, not silently rewritten.

The manual `hermes-promote.yml` release builds both original recipes, scans all
layers and image metadata for secrets, runs a backend/desktop startup smoke and a
real Hermes Codex subscription answer, then publishes an immutable `sha-<commit>`
tag to the private `ghcr.io/hexorx/agent-box-hermes` package and verifies its digest.
Use the saved `HERMES_SUBSCRIPTION_AUTH_JSON` CI secret only at runtime.
SBOM/vulnerability reports are informational. Test containers are stopped and
retained; no images, volumes or operator data are deleted by these scripts.

No deployment is included. Rollback a later operator-owned rollout by restoring
the prior image digest with its existing home volume; never replace or delete
that volume. The live box is outside this change.
