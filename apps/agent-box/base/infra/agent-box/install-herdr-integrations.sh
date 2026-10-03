#!/bin/sh
# Install herdr plugins for Hermes and OMP (oh-my-pi).
# https://herdr.dev/docs/integrations/#hermes-agent
# Idempotent. Hermes install requires ~/.hermes; OMP requires ~/.omp/agent.
set -e
HOME="${HOME:-/home/agent}"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
HERDR="${HERDR_BIN:-herdr}"

if [ -x "$HERDR" ]; then
    :
elif command -v "$HERDR" >/dev/null 2>&1; then
    HERDR=$(command -v "$HERDR")
else
    echo "herdr: binary not found, skipping integrations" >&2
    exit 0
fi

install_one() {
    name=$1
    echo "herdr: installing $name integration" >&2
    "$HERDR" integration install "$name" || echo "herdr: $name integration skipped" >&2
}

if [ -d "$HERMES_HOME" ]; then
    install_one hermes
fi

mkdir -p "$HOME/.omp/agent"
install_one omp
