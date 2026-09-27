#!/bin/sh
set -eu
n=0
until [ -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ]; do
    n=$((n + 1))
    [ "$n" -lt 150 ] || exit 1
    sleep 0.2
done
exec "$@"
