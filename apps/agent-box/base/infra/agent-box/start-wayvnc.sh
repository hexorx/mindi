#!/bin/sh
set -e
set -a
[ -f /run/agent-box.env ] && . /run/agent-box.env
set +a
export HOME="${HOME:-/home/agent}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1000}"
export WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}"
export XDG_SESSION_TYPE=wayland
socket="$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY"
i=0
while [ ! -S "$socket" ]; do
    i=$((i + 1))
    if [ "$i" -gt 150 ]; then
        echo "wayvnc: timed out waiting for $socket" >&2
        exit 1
    fi
    sleep 0.2
done
exec wayvnc --disable-resizing 127.0.0.1 5900
