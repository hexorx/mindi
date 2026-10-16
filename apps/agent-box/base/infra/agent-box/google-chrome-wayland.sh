#!/bin/sh
exec /home/agent/.local/share/mindi-tools/chrome/opt/google/chrome/chrome \
    --ozone-platform=wayland \
    --enable-features=UseOzonePlatform \
    --disable-dev-shm-usage \
    --no-sandbox \
    --disable-setuid-sandbox \
    --no-first-run \
    --disable-gpu \
    --force-renderer-accessibility \
    "$@"
