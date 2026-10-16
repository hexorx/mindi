#!/bin/sh
# Retry identity until a GitHub token exists, then keep the marker path warm.
set -e
configured=0
while true; do
  set +e
  set -a
  [ -f /run/agent-box.env ] && . /run/agent-box.env
  set +a
  TOKEN_PATH="${GITHUB_TOKEN_PATH:-$HOME/.secrets/github-token}"
  MARKER="${AGENT_BOX_MARKER:-$HOME/.local/state/agent-box-bootstrapped}"
  if [ -z "${GH_TOKEN:-}" ] && [ -f "$TOKEN_PATH" ]; then
    GH_TOKEN=$(cat "$TOKEN_PATH")
    export GH_TOKEN GITHUB_TOKEN="$GH_TOKEN"
  fi
  if [ -n "${GH_TOKEN:-}" ]; then
    /opt/identity.sh || true
    if [ "$configured" = 0 ] && [ -f "$MARKER" ]; then
      /opt/configure-agent-box.sh || true
      /opt/start-gateway.sh || true
      configured=1
    fi
  fi
  sleep 15
done
