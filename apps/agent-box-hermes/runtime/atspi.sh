#!/bin/sh
set -eu
for binary in /usr/libexec/at-spi-bus-launcher /usr/lib/at-spi2-core/at-spi-bus-launcher; do
    if [ -x "$binary" ]; then exec "$binary" --launch-immediately; fi
done
exit 1
