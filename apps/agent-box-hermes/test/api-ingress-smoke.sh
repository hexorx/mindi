#!/usr/bin/env bash
# Exercise only non-inference routes with a disposable fixture key.
set -euo pipefail
base=${1:?Supply the HTTPS entrypoint}
certificate=${2:?Supply the trusted certificate}
key=${3:?Supply the fixture API key}
expect_status() {
    local expected=$1 path=$2 auth=$3 actual
    local -a headers=()
    case "$auth" in
        missing) ;;
        wrong) headers=(-H 'Authorization: Bearer wrong-fixture-key') ;;
        valid) headers=(-H "Authorization: Bearer $key") ;;
    esac
    actual=$(curl --cacert "$certificate" -sS -o /dev/null -w '%{http_code}' "${headers[@]}" "$base$path")
    if [ "$actual" != "$expected" ]; then
        printf 'API ingress: %s (%s auth): expected %s, got %s\n' "$path" "$auth" "$expected" "$actual" >&2
        return 1
    fi
}
# Supported health routes enforce Bearer auth through the supervised gateway.
for path in /health /health/detailed /v1/health; do
    expect_status 401 "$path" missing
    expect_status 401 "$path" wrong
    expect_status 200 "$path" valid
done
# Native discovery and alternate inference routes stay closed even with a key.
for path in /v1/models /v1/capabilities /v1/chat/completions /v1/responses /api/jobs /p/default/v1/runs; do
    for auth in missing wrong valid; do
        expect_status 403 "$path" "$auth"
    done
done
printf 'API ingress authentication and alternate-route denial passed.\n'
