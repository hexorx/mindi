#!/usr/bin/env bash
# No port publishing, inference spend, or cleanup of containers/volumes/evidence.
set -Eeuo pipefail
image=${1:?Supply the locally built image tag or exact digest}
tests=$(cd "$(dirname "$0")" && pwd)
scratch=$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${RUNNER_TEMP:-/tmp}}/hermes-offline.XXXXXX")
container="hermes-offline-${RANDOM}-${RANDOM}"
finish() {
    result=$?
    trap - EXIT
    docker logs "$container" > "$scratch/container.log" 2>&1 || true
    docker stop --time 20 "$container" >/dev/null 2>&1 || true
    printf 'Offline startup evidence: %s; stopped container: %s; volumes retained\n' "$scratch" "$container"
    exit "$result"
}
trap finish EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
    -addext subjectAltName=DNS:localhost,IP:127.0.0.1 \
    -keyout "$scratch/desktop_tls_key" -out "$scratch/desktop_tls_cert" >/dev/null 2>&1
openssl rand -hex 24 > "$scratch/desktop_password"
docker run -d --name "$container" --network none --shm-size=256m --security-opt=no-new-privileges \
    -e API_SERVER_KEY=fixture-only-api-key-for-smoke \
    -e PAPERCLIP_CALLBACK_KEY=fixture-only-callback-key-for-smoke \
    -e PAPERCLIP_API_URL=http://paperclip.invalid/api \
    --mount "type=volume,src=$container-home,dst=/home/agent" \
    --mount "type=volume,src=$container-memory,dst=/var/lib/agent-box/hindsight" \
    --mount "type=volume,src=$container-data,dst=/opt/data" \
    --mount "type=bind,src=$tests,dst=/test,readonly" \
    --mount "type=bind,src=$scratch,dst=/run/secrets,readonly" "$image" >/dev/null
[ "$(docker inspect -f '{{.HostConfig.NetworkMode}}' "$container")" = none ]
healthy=false
for _ in $(seq 1 150); do
    state=$(docker inspect -f '{{.State.Status}}' "$container")
    [ "$state" != exited ] && [ "$state" != dead ] || exit 1
    if [ "$(docker inspect -f '{{.State.Health.Status}}' "$container")" = healthy ]; then
        healthy=true
        break
    fi
    sleep 2
done
[ "$healthy" = true ]
docker exec --user 1000:1000 "$container" /opt/hermes/.venv/bin/python /test/file-memory-probe.py write
docker exec --user 1000:1000 "$container" /opt/hermes/.venv/bin/python /test/file-memory-probe.py read
docker inspect "$container" > "$scratch/container-inspect.json"
printf 'Fresh-volume offline startup, desktop/API health and file memory passed without provider keys.\n'
