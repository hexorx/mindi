#!/bin/sh
# Userspace tailscaled + Serve. Funnel webhooks on :8443 only.
# Loopback backends only. Never Funnel 443 or 5900.
set -e
set -a
[ -f /run/agent-box.env ] && . /run/agent-box.env
set +a

STATE_DIR="${TS_STATE_DIR:-/home/agent/.local/share/tailscale}"
SOCKET="${TS_SOCKET:-/var/run/tailscale/tailscaled.sock}"

if [ -z "${TS_AUTHKEY:-}" ] && [ -n "${TS_AUTHKEY_FILE:-}" ] && [ -r "$TS_AUTHKEY_FILE" ]; then
    TS_AUTHKEY=$(tr -d '\n' < "$TS_AUTHKEY_FILE")
fi

has_state=0
if [ -d "$STATE_DIR" ] && [ "$(ls -A "$STATE_DIR" 2>/dev/null)" ]; then
    has_state=1
fi

if [ -z "${TS_AUTHKEY:-}" ] && [ "$has_state" -eq 0 ]; then
    echo "tailscale: no auth key yet" >&2
    exec sleep infinity
fi

if [ -z "${PERSONA_NAME:-}" ]; then
    echo "tailscale: PERSONA_NAME is required" >&2
    exec sleep infinity
fi

mkdir -p "$STATE_DIR" "$(dirname "$SOCKET")"

tailscaled --tun=userspace-networking --statedir="$STATE_DIR" --socket="$SOCKET" &
daemon_pid=$!

i=0
while [ ! -S "$SOCKET" ] && [ "$i" -lt 20 ]; do
    i=$((i + 1))
    sleep 0.1
done

up() {
    if [ -n "${TS_AUTHKEY:-}" ]; then
        tailscale --socket="$SOCKET" up --hostname "$PERSONA_NAME" --ssh --auth-key "$TS_AUTHKEY"
    else
        tailscale --socket="$SOCKET" up --hostname "$PERSONA_NAME" --ssh
    fi
}

while ! up; do
    echo "tailscale: up failed, retrying" >&2
    sleep 5
done

while ! tailscale --socket="$SOCKET" serve --bg --https=443 http://127.0.0.1:9119; do
    echo "tailscale: serve https retry" >&2
    sleep 2
done

while ! tailscale --socket="$SOCKET" serve --bg --tcp=5900 tcp://127.0.0.1:5900; do
    echo "tailscale: serve vnc retry" >&2
    sleep 2
done

if [ -n "${HERMES_WEBHOOK_SECRET:-}" ]; then
    i=0
    while [ "$i" -lt 15 ]; do
        if tailscale --socket="$SOCKET" funnel --bg --https=8443 --yes http://127.0.0.1:8644; then
            break
        fi
        echo "tailscale: funnel webhook retry" >&2
        i=$((i + 1))
        sleep 2
    done
    if [ "$i" -ge 15 ]; then
        echo "tailscale: funnel webhook failed; dashboard and VNC stay tailnet-only" >&2
    fi
else
    echo "tailscale: skip funnel; HERMES_WEBHOOK_SECRET unset" >&2
fi

wait "$daemon_pid"
