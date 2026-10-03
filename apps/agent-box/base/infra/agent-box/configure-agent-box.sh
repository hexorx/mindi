#!/bin/sh
# Idempotent Buzz / computer_use / webhook / herdr wiring. Does not start the gateway.
set -e
set -a
[ -f /run/agent-box.env ] && . /run/agent-box.env
set +a
export HOME="${HOME:-/home/agent}"
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
export PATH="/opt/hermes/bin:/opt/hermes/.venv/bin:$HOME/.local/bin:/usr/local/bin:$PATH"
export DISPLAY="${DISPLAY:-:0}"
export XDG_SESSION_TYPE="${XDG_SESSION_TYPE:-wayland}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1000}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
export CUA_DRIVER_RS_ENABLE_WAYLAND="${CUA_DRIVER_RS_ENABLE_WAYLAND:-1}"
export CUA_DRIVER_RS_TELEMETRY_ENABLED="${CUA_DRIVER_RS_TELEMETRY_ENABLED:-0}"
export GTK_A11Y="${GTK_A11Y:-atspi}"
PROFILE="${PERSONA_NAME:-${HERMES_PROFILE:-default}}"

node /opt/configure-hermes-buzz.mjs || echo "hermes: buzz config skipped" >&2
node /opt/configure-hermes-computer-use.mjs || echo "hermes: computer_use config skipped" >&2
node /opt/configure-hermes-hindsight.mjs || echo "hermes: hindsight config skipped" >&2
node /opt/configure-hermes-dashboard.mjs || echo "hermes: dashboard config skipped" >&2
node /opt/configure-hermes-webhook.mjs || echo "hermes: webhook config skipped" >&2
sh /opt/install-herdr-integrations.sh || echo "hermes: herdr integrations skipped" >&2

PLUGIN_ROOT=/opt/mindi-plugins
if [ -d "$PLUGIN_ROOT" ]; then
    mkdir -p "$HERMES_HOME/plugins"
    for src in "$PLUGIN_ROOT"/*; do
        [ -d "$src" ] || continue
        name=$(basename "$src")
        rm -rf "$HERMES_HOME/plugins/$name"
        cp -a "$src" "$HERMES_HOME/plugins/$name" || echo "hermes: plugin $name copy skipped" >&2
    done
fi

PROFILE_DIR="$HERMES_HOME/profiles/$PROFILE"
if [ -d "$PROFILE_DIR" ] && [ ! -f "$PROFILE_DIR/gateway_state.json" ]; then
    printf '%s\n' '{"gateway_state":"running","desired_state":"running"}' \
        > "$PROFILE_DIR/gateway_state.json"
fi
