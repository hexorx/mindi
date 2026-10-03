#!/bin/sh
# Join-only Buzz presence. No-ops until buzz-cli is on PATH.
set -a
[ -f /run/agent-box.env ] && . /run/agent-box.env
set +a
export HOME="${HOME:-/home/agent}"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

if [ -z "${BUZZ_PRIVATE_KEY:-}" ] || [ -z "${BUZZ_RELAY_URL:-}" ]; then
    echo "buzz-presence: missing BUZZ_PRIVATE_KEY or BUZZ_RELAY_URL" >&2
    exec tail -f /dev/null
fi

while true; do
    if command -v buzz >/dev/null 2>&1; then
        buzz users set-presence --status online >/dev/null 2>&1 || true
    fi
    sleep 60
done
