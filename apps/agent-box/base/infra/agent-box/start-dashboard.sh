#!/bin/sh
# Hermes dashboard (basic auth from configure-hermes-dashboard). Not a second gateway.
set -e
set -a
[ -f /run/agent-box.env ] && . /run/agent-box.env
set +a
export HOME="${HOME:-/home/agent}"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
export PATH="/opt/hermes/bin:/opt/hermes/.venv/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
PROFILE="${PERSONA_NAME:-${HERMES_PROFILE:-default}}"
if [ -n "${DASHBOARD_PASSWORD:-}" ]; then
    export HERMES_DASHBOARD_BASIC_AUTH_USERNAME="${DASHBOARD_USER:-partner}"
    export HERMES_DASHBOARD_BASIC_AUTH_PASSWORD="${DASHBOARD_PASSWORD}"
fi

if ! command -v hermes >/dev/null 2>&1; then
    echo "hermes: binary not on PATH, skip dashboard start" >&2
    exit 0
fi

exec hermes -p "$PROFILE" dashboard --host 0.0.0.0 --port 9119 --no-open
