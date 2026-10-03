#!/bin/sh
exec /usr/bin/google-chrome-stable \
    --ozone-platform=wayland \
    --enable-features=UseOzonePlatform \
    --disable-dev-shm-usage \
    --no-sandbox \
    --disable-setuid-sandbox \
    --no-first-run \
    --disable-gpu \
    --force-renderer-accessibility \
    "$@"
