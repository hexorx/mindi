#!/bin/sh
# Keep a herdr server alive without attaching a TUI under s6.
set -e
set -a
[ -f /run/agent-box.env ] && . /run/agent-box.env
set +a
export HOME="${HOME:-/home/agent}"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

if ! command -v herdr >/dev/null 2>&1; then
    echo "herdr: installing" >&2
    curl -fsSL https://herdr.dev/install.sh | sh
    export PATH="$HOME/.local/bin:$PATH"
fi

herdr session list --json >/dev/null 2>&1 || true
sh /opt/install-herdr-integrations.sh || echo "herdr: integrations skipped" >&2
echo "herdr: server should be running; sleeping under s6" >&2
exec tail -f /dev/null
