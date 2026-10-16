#!/bin/sh
# Per-box backend. Exec preserves supervisor signals and the backend exit status.
set -eu
umask 077
: "${MINDI_BACKEND_CONFIG:?Set MINDI_BACKEND_CONFIG to the backend configuration file}"
if [ ! -r "$MINDI_BACKEND_CONFIG" ]; then
    echo "Backend configuration is not readable" >&2
    exit 1
fi
if [ -n "${MINDI_BACKEND_TOKEN_FILE:-}" ]; then
    if [ ! -r "$MINDI_BACKEND_TOKEN_FILE" ]; then
        echo "Backend token file is not readable" >&2
        exit 1
    fi
    MINDI_BACKEND_TOKEN=$(cat "$MINDI_BACKEND_TOKEN_FILE")
fi
: "${MINDI_BACKEND_TOKEN:?Set MINDI_BACKEND_TOKEN or MINDI_BACKEND_TOKEN_FILE}"
export MINDI_BACKEND_TOKEN
exec node /opt/mindi-backend/dist/main.js "$MINDI_BACKEND_CONFIG"
