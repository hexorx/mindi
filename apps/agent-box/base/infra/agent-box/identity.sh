#!/bin/sh
# First-boot identity: GitHub auth, chezmoi/dotfiles, Hermes persona.
# Idempotent: a marker file skips work on later starts.
set -e

if [ -f /run/agent-box.env ]; then
    set -a
    # shellcheck disable=SC1091
    . /run/agent-box.env
    set +a
fi

export HOME="${HOME:?identity: HOME not set}"
GITHUB_OWNER="${GITHUB_OWNER:?identity: GITHUB_OWNER not set}"
PERSONA_NAME="${PERSONA_NAME:?identity: PERSONA_NAME not set}"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
MARKER="${AGENT_BOX_MARKER:-$HOME/.local/state/agent-box-bootstrapped}"
DOTFILES_REPO="${DOTFILES_REPO:-https://github.com/${GITHUB_OWNER}/dotfiles}"
PERSONA_REPO="${PERSONA_REPO:-github.com/${GITHUB_OWNER}/${GITHUB_OWNER}}"

mkdir -p "$(dirname "$MARKER")"

if [ -f "$MARKER" ]; then
    echo "identity: already bootstrapped ($MARKER)" >&2
    exit 0
fi

if [ -z "${GH_TOKEN:-}" ]; then
    echo "identity: GH_TOKEN is not set yet; waiting for onboarding" >&2
    exit 0
fi

echo "identity: authenticating gh as $GITHUB_OWNER" >&2
printf '%s\n' "$GH_TOKEN" | gh auth login --with-token --hostname github.com
gh auth setup-git --hostname github.com || true

if [ ! -f "$HOME/.zshrc" ]; then
    echo "identity: applying dotfiles from $DOTFILES_REPO" >&2
    chezmoi init --apply "$DOTFILES_REPO"
    if command -v mise >/dev/null 2>&1; then
        export PATH="$HOME/.local/bin:$PATH"
        mise install --yes || true
    fi
fi

PROFILE_DIR="${HERMES_PROFILE_DIR:-$HERMES_HOME/profiles/$PERSONA_NAME}"
if [ ! -d "$PROFILE_DIR" ]; then
    echo "identity: installing persona $PERSONA_REPO" >&2
    hermes profile install "$PERSONA_REPO" --name "$PERSONA_NAME" || \
        hermes profile install "https://github.com/${GITHUB_OWNER}/${GITHUB_OWNER}" --name "$PERSONA_NAME"
fi

CONFIG="$PROFILE_DIR/config.yaml"
EXAMPLE="$PROFILE_DIR/config.yaml.example"
if [ ! -f "$CONFIG" ] && [ -f "$EXAMPLE" ]; then
    cp "$EXAMPLE" "$CONFIG"
fi

date -u +"%Y-%m-%dT%H:%M:%SZ" > "$MARKER"
echo "identity: bootstrap complete" >&2
