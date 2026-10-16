#!/bin/sh
set -a
[ -f /run/agent-box.env ] && . /run/agent-box.env
set +a
export HOME="${HOME:-/home/agent}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/1000}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
for bin in /usr/libexec/at-spi-bus-launcher /usr/lib/at-spi2-core/at-spi-bus-launcher; do
    if [ -x "$bin" ]; then
        exec "$bin" --launch-immediately
    fi
done
echo "at-spi: launcher not found" >&2
exit 1
