# Optional config sources

Boot uses packaged defaults without a GitHub account, token, or network request.
An operator can select a public GitHub source with these container variables:

| Variable | Meaning |
| --- | --- |
| `AGENT_BOX_CONFIG_SOURCE` | `github:user/alice`, `github:org/team`, or `github:repo/team/settings` |
| `AGENT_BOX_CONFIG_REF` | Required with a source: preferably a full lowercase 40-character commit SHA; an explicit branch/tag is resolved once and pinned |
| `AGENT_BOX_CONFIG_MANIFEST` | Repository-relative manifest path, default `agent-box.yaml` |
| `AGENT_BOX_CONFIG_LOCAL` | Optional read-only mounted directory containing `agent-box.yaml` and persona files |
| `AGENT_BOX_CONFIG_REQUIRED` | `true` makes source failure fatal to boot; default `false` |
| `AGENT_BOX_CONFIG_TOKEN_FILE` | Optional mounted read-only GitHub credential file, used only for fetching private config |

User and org conventions map to `alice/alice` and `team/.github` respectively.
The resolver only contacts `api.github.com`, rejects redirects, and never clones
or executes a repository. Grant private-source credentials **Contents: read**
only on the selected repository; they are not installed as the agent's GitHub
identity. No credential value belongs in a manifest or environment variable.

Use YAML or JSON with this strict, versioned settings schema:

```yaml
schemaVersion: 1
flavor: hermes
identity:
  name: helper
hermes:
  model: operator-selected-model
persona:
  instructionsFile: persona/AGENTS.md
```

Only `schemaVersion` and `flavor` are mandatory. Identity is display metadata,
model selects the Hermes model, and persona text becomes the root profile's
`AGENTS.md`. Persona paths are relative to the manifest directory. This is a
settings patch, not the full box deployment contract: network, memory, secrets,
environment maps, tools, plugins and hooks are rejected. Persona is untrusted
instruction text; select sources you trust to supply agent instructions.

Precedence is an explicit local mount, existing operator model/persona migrated
from the root profile, remote settings, then packaged defaults. Other existing
operator JSON configuration is preserved, including security and computer-use
settings. An invalid local mount fails closed. Generated profile files are managed
symlinks: use the local mount to change settings, rather than editing those files.

Remote manifests are limited to 64 KiB, personas to 256 KiB, each API response to
1 MiB, path depth to 16, and HTTP socket operations to ten seconds. Paths cannot
traverse or contain URL encodings. Local symlinks and remote Git symlinks,
submodules, and executable files are rejected. Git tree modes are inspected
because the [Contents API can dereference symlinks](https://docs.github.com/en/rest/repos/contents#get-repository-content).
YAML object tags, duplicate keys, aliases and anchors are rejected. Only the
manifest and its declared persona blob are downloaded, plus Git object metadata.

## Refresh, status and rollback

Run as uid 1000 in the container, between agent runs:

```sh
python3 /opt/agent-box/config_sources.py status
python3 /opt/agent-box/config_sources.py refresh
python3 /opt/agent-box/config_sources.py rollback
```

Boot reuses the saved immutable revision without contacting GitHub. `refresh`
resolves the configured ref again, downloads and validates the complete candidate,
then switches one active snapshot pointer. Configuration, persona, effective
settings and provenance live in the same snapshot under
`~/.hermes/.agent-box/`. Refreshes are serialized with a filesystem lock. Consumers
that need multiple files consistently should resolve `current` once and read
that revision directory. Existing Hermes processes may cache settings: finish the
current run and start a new Hermes invocation after refresh/rollback.

Optional fetch/validation failure uses packaged defaults on first boot, or the
last good remote data later. Status reports `degraded`, the effective source,
immutable commit, content hash and a redacted reason. Failed/no-op refreshes do
not consume rollback history. Required-source failure aborts bootstrap; an already
pinned cached source remains usable without a new fetch. Explicit required refresh
failure returns nonzero and leaves the active configuration unchanged.

Rollback activates the previous successful snapshot without a network request.
Boot retains that pinned revision until the next explicit refresh. Removing the
source environment variable returns to local/default settings on the next boot.
Snapshot history is retained in the home volume; do not copy credentials into it.
The first migration records existing operator JSON config/persona before installing
managed links. Boot rejects additional profiles and unmanaged symlinks.

Roll out through Opi after merge: use a canary image and backed-up home volume,
verify no-source boot, local settings, refresh and rollback before enabling a remote
source. For config rollback use the command above. To downgrade to the pre-P5 image,
stop the box and restore the backed-up home volume (the old configurator rejects
managed symlinks); preserve sessions separately if needed. No production deployment
or shared database migration is included.
