#!/bin/sh
# Run in the pinned Go source tree after building both binaries.
set -eu
bin_dir=${1:-/usr/local/bin}
tags=ts_kube,ts_package_container,ts_omit_webclient
# Inspect selected packages AND embed inputs, not the unused source/module cache.
deps=$(go list -mod=readonly -tags="$tags" -deps -f '{{.ImportPath}} {{join .EmbedFiles " "}}' ./cmd/tailscale ./cmd/tailscaled)
if printf '%s\n' "$deps" | grep -E 'tailscale.com/client/web|github.com/tailscale/web-client-prebuilt'; then
    echo 'FAIL: web client package or embed input selected' >&2
    exit 1
fi
for name in tailscale tailscaled; do
    binary="$bin_dir/$name"
    metadata=$(go version -m "$binary")
    printf '%s\n' "$metadata" | grep -F -- "-tags=$tags" >/dev/null
    if printf '%s\n' "$metadata" | grep -F 'github.com/tailscale/web-client-prebuilt'; then
        echo "FAIL: web client dependency in $name" >&2
        exit 1
    fi
    symbols=$(go tool nm "$binary")
    if printf '%s\n' "$symbols" | grep -E 'tailscale.com/client/web\.|github.com/tailscale/web-client-prebuilt'; then
        echo "FAIL: web client symbols in $name" >&2
        exit 1
    fi
    echo "PASS: $name omission tag present; web client dependency and symbols absent"
done
set +e
output=$("$bin_dir/tailscale" web 2>&1)
status=$?
set -e
printf '%s\n' "$output"
if [ "$status" -eq 0 ] || ! printf '%s\n' "$output" | grep -F 'tailscale: unknown subcommand: web' >/dev/null; then
    echo 'FAIL: tailscale web was not explicitly unavailable' >&2
    exit 1
fi
echo 'PASS: web command unavailable; selected web packages and embed inputs absent'
