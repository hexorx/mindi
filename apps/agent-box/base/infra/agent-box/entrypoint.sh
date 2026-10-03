#!/bin/sh
# Agent-box wrapper: compose env/files via bootfetch, then official Hermes s6.
set -e

export HOME="${HOME:-/home/agent}"
export USER="${USER:-hermes}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1000}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"
export XDG_SESSION_TYPE=wayland
export HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"

SECRETS="${SECRETS_DIR:-$HOME/.secrets}"
mkdir -p "$SECRETS" "$HOME/.config/wayvnc" "$HOME/.ssh" /var/run/sshd "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"

# bootfetch writes token files then execs us again with secrets in env.
if [ "${BOOTFETCH_DONE:-}" != "1" ]; then
    export AGENT_BOX=1
    export GITHUB_TOKEN_PATH="${GITHUB_TOKEN_PATH:-$SECRETS/github-token}"
    export GH_REVIEW_TOKEN_PATH="${GH_REVIEW_TOKEN_PATH:-$SECRETS/gh-review-token}"
    export GH_PM_TOKEN_PATH="${GH_PM_TOKEN_PATH:-$SECRETS/gh-pm-token}"
    export BUZZ_KEY_PATH="${BUZZ_KEY_PATH:-$SECRETS/buzz-key}"
    export BUZZ_RELAY_URL_PATH="${BUZZ_RELAY_URL_PATH:-$SECRETS/buzz-relay}"
    export VNC_PASSWORD_PATH="${VNC_PASSWORD_PATH:-$SECRETS/vnc-password}"
    export BOOTFETCH_DONE=1
    exec /opt/bootfetch.sh /opt/entrypoint.sh "$@"
fi

if [ -f "$BUZZ_KEY_PATH" ]; then
    BUZZ_PRIVATE_KEY=$(cat "$BUZZ_KEY_PATH")
    export BUZZ_PRIVATE_KEY
fi
if [ -f "$BUZZ_RELAY_URL_PATH" ]; then
    BUZZ_RELAY_URL=$(cat "$BUZZ_RELAY_URL_PATH")
    export BUZZ_RELAY_URL
fi
if [ -f "$GITHUB_TOKEN_PATH" ]; then
    GH_TOKEN=$(cat "$GITHUB_TOKEN_PATH")
    export GH_TOKEN GITHUB_TOKEN="$GH_TOKEN"
fi
if [ -n "${GH_REVIEW_TOKEN_PATH:-}" ] && [ -f "$GH_REVIEW_TOKEN_PATH" ]; then
    GH_REVIEW_TOKEN=$(cat "$GH_REVIEW_TOKEN_PATH")
    export GH_REVIEW_TOKEN
fi
if [ -n "${GH_PM_TOKEN_PATH:-}" ] && [ -f "$GH_PM_TOKEN_PATH" ]; then
    GH_PM_TOKEN=$(cat "$GH_PM_TOKEN_PATH")
    export GH_PM_TOKEN
fi

umask 077
cat > /run/agent-box.env <<EOF
HOME=$HOME
USER=hermes
HERMES_HOME=$HERMES_HOME
HERMES_UID=${HERMES_UID:-1000}
HERMES_GID=${HERMES_GID:-1000}
XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR
WAYLAND_DISPLAY=$WAYLAND_DISPLAY
XDG_SESSION_TYPE=wayland
DISPLAY=:0
DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
CUA_DRIVER_RS_ENABLE_WAYLAND=1
CUA_DRIVER_RS_TELEMETRY_ENABLED=0
GTK_A11Y=atspi
PERSONA_NAME=${PERSONA_NAME:-}
GITHUB_OWNER=${GITHUB_OWNER:-}
GH_TOKEN=${GH_TOKEN:-}
GITHUB_TOKEN=${GH_TOKEN:-}
GITHUB_OAUTH_CLIENT_ID=${GITHUB_OAUTH_CLIENT_ID:-}
HERMES_WEBHOOK_SECRET=${HERMES_WEBHOOK_SECRET:-}
GITHUB_TOKEN_PATH=${GITHUB_TOKEN_PATH:-}
DASHBOARD_USER=${DASHBOARD_USER:-partner}
DASHBOARD_PASSWORD=${DASHBOARD_PASSWORD:-}
HINDSIGHT_API_URL=${HINDSIGHT_API_URL:-http://127.0.0.1:8888}
HINDSIGHT_API_HOST=${HINDSIGHT_API_HOST:-127.0.0.1}
HINDSIGHT_API_PORT=${HINDSIGHT_API_PORT:-8888}
HINDSIGHT_API_LLM_PROVIDER=${HINDSIGHT_API_LLM_PROVIDER:-}
HINDSIGHT_API_LLM_MODEL=${HINDSIGHT_API_LLM_MODEL:-}
HINDSIGHT_API_LLM_API_KEY=${HINDSIGHT_API_LLM_API_KEY:-}
HINDSIGHT_API_LLM_BASE_URL=${HINDSIGHT_API_LLM_BASE_URL:-}
BUZZ_PRIVATE_KEY=${BUZZ_PRIVATE_KEY:-}
BUZZ_RELAY_URL=${BUZZ_RELAY_URL:-}
BUZZ_KEY_PATH=${BUZZ_KEY_PATH:-}
BUZZ_RELAY_URL_PATH=${BUZZ_RELAY_URL_PATH:-}
HERMES_PROFILE=${PERSONA_NAME:-}
EOF
for var in BUZZ_CHANNELS BUZZ_HOME_CHANNEL BUZZ_ALLOWED_USERS BUZZ_ALLOW_ALL_USERS; do
    eval "val=\${$var:-}"
    if [ -n "$val" ]; then
        printf '%s=%s\n' "$var" "$val" >> /run/agent-box.env
    fi
done
chmod 600 /run/agent-box.env

if [ -f "$VNC_PASSWORD_PATH" ]; then
    VNC_PASSWORD=$(cat "$VNC_PASSWORD_PATH")
    cat > "$HOME/.config/wayvnc/config" <<EOF
address=127.0.0.1
port=5900
enable_auth=true
username=agent
password=$VNC_PASSWORD
relax_encryption=true
EOF
    chmod 600 "$HOME/.config/wayvnc/config"
fi

if [ -n "${SSH_AUTHORIZED_KEYS:-}" ]; then
    printf '%s\n' "$SSH_AUTHORIZED_KEYS" > "$HOME/.ssh/authorized_keys"
elif [ -f /etc/agent-box/authorized_keys ]; then
    cp /etc/agent-box/authorized_keys "$HOME/.ssh/authorized_keys"
fi
chmod 700 "$HOME/.ssh"
[ -f "$HOME/.ssh/authorized_keys" ] && chmod 600 "$HOME/.ssh/authorized_keys"

exec /opt/hermes/docker/entrypoint-dispatch.sh "$@"
