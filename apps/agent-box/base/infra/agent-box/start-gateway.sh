#!/bin/sh
# Ask s6 to bring up the coordinator profile gateway. Safe to call repeatedly.
set -e
set -a
[ -f /run/agent-box.env ] && . /run/agent-box.env
set +a
export HOME="${HOME:-/home/agent}"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
export PATH="/opt/hermes/bin:/opt/hermes/.venv/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
PROFILE="${PERSONA_NAME:-${HERMES_PROFILE:-default}}"

if ! command -v hermes >/dev/null 2>&1; then
    echo "hermes: binary not on PATH, skip gateway start" >&2
    exit 0
fi

hermes -p "$PROFILE" gateway start
