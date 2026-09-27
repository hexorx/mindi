#!/usr/bin/env bash
set -euo pipefail
image=${1:?Supply the locally built image tag}
scratch=$(mktemp -d)
tests=$(cd "$(dirname "$0")" && pwd)
container="hermes-smoke-${RANDOM}-${RANDOM}"
home_volume="$container-home"
memory_volume="$container-memory"
restore_volume="$container-restored"
cleanup() {
    docker rm -fv "$container" >/dev/null 2>&1 || true
    docker volume rm "$home_volume" "$memory_volume" "$restore_volume" >/dev/null 2>&1 || true
    rm -rf "$scratch"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
    -addext subjectAltName=DNS:localhost,IP:127.0.0.1 \
    -keyout "$scratch/desktop_tls_key" -out "$scratch/desktop_tls_cert" >/dev/null 2>&1
openssl rand -hex 24 > "$scratch/desktop_password"
# curl credentials stay in a private disposable file, never command arguments/logs.
python3 - "$scratch" <<'PYTHON'
import pathlib, sys
p = pathlib.Path(sys.argv[1])
(p / 'curl.conf').write_text('user = "desktop:' + (p / 'desktop_password').read_text().strip() + '"\n')
(p / 'curl.conf').chmod(0o600)
PYTHON
printf 'fixture-llm-key' > "$scratch/memory_llm_key"
printf 'fixture-embedding-key' > "$scratch/memory_embeddings_key"
docker volume create "$home_volume" >/dev/null
docker volume create "$memory_volume" >/dev/null
start_container() {
    docker run -d --name "$container" --shm-size=256m --security-opt=no-new-privileges \
        -e MEMORY_LLM_BASE_URL=http://127.0.0.1:9999/v1 \
        -e MEMORY_EMBEDDINGS_BASE_URL=http://127.0.0.1:9999/v1 \
        --mount "type=volume,src=$home_volume,dst=/home/agent" \
        --mount "type=volume,src=$1,dst=/var/lib/agent-box/hindsight" \
        --mount "type=bind,src=$tests,dst=/test,readonly" \
        -p 127.0.0.1::8443 --mount "type=bind,src=$scratch,dst=/run/secrets,readonly" "$image" >/dev/null
    start_fixture
}
start_fixture() {
    docker exec -d --user 1000:1000 "$container" python3 /test/mock-memory-provider.py
}
wait_healthy() {
    for _ in $(seq 1 150); do
        state=$(docker inspect -f '{{.State.Status}}' "$container")
        if [ "$state" = exited ] || [ "$state" = dead ]; then
            docker logs "$container"
            exit 1
        fi
        health=$(docker inspect -f '{{.State.Health.Status}}' "$container")
        [ "$health" != healthy ] || return 0
        sleep 2
    done
    docker logs "$container"
    exit 1
}
start_container "$memory_volume"
wait_healthy
# Exercise configuration validation with root-owned Docker output descriptors.
# Reopening /dev/stderr after switching to uid 1000 must not be required.
docker exec --user 1000:1000 "$container" nginx -t -c /etc/agent-box/nginx.conf
# Every enabled nginx module must use private, service-writable temp storage.
docker exec --user 1000:1000 "$container" python3 -c '
import os
from pathlib import Path
for name in ("client", "proxy", "fastcgi", "uwsgi", "scgi"):
    path = Path("/run/user/1000") / name
    assert path.is_dir() and os.access(path, os.W_OK), str(path)
'
port=$(docker port "$container" 8443/tcp | sed 's/.*://')
base="https://127.0.0.1:$port"
for path in /vnc.html /websockify; do
    code=$(curl --cacert "$scratch/desktop_tls_cert" -s -o /dev/null -w '%{http_code}' "$base$path")
    [ "$code" = 401 ]
done
curl --cacert "$scratch/desktop_tls_cert" --config "$scratch/curl.conf" -fsS "$base/vnc.html" -o /dev/null
code=$(curl --cacert "$scratch/desktop_tls_cert" --config "$scratch/curl.conf" -H 'Origin: https://untrusted.invalid' -s -o /dev/null -w '%{http_code}' "$base/websockify")
[ "$code" = 403 ]
# Prove authenticated WebSocket upgrade reaches the real RFB endpoint.
python3 - "$scratch" "$port" <<'PYTHON'
import base64, pathlib, socket, ssl, sys
p = pathlib.Path(sys.argv[1]); port = int(sys.argv[2])
ctx = ssl.create_default_context(cafile=str(p / 'desktop_tls_cert'))
credential = base64.b64encode(b'desktop:' + (p / 'desktop_password').read_bytes().strip()).decode()
with ctx.wrap_socket(socket.create_connection(('127.0.0.1', port)), server_hostname='localhost') as s:
    s.settimeout(5)
    request = (f'GET /websockify HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n'
               f'Authorization: Basic {credential}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
               'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
    s.sendall(request.encode())
    response = b''
    while b'\r\n\r\n' not in response: response += s.recv(4096)
    assert response.split(b'\r\n', 1)[0].endswith(b'101 Switching Protocols'), 'WebSocket authentication/upgrade failed'
PYTHON
docker exec --user 1000:1000 "$container" /opt/hermes/.venv/bin/python /opt/agent-box/smoke.py
docker exec --user 1000:1000 "$container" python3 /test/memory-probe.py retain
# A process/container restart must preserve data and the box-derived bank.
docker restart --time 20 "$container" >/dev/null
start_fixture
wait_healthy
docker exec --user 1000:1000 "$container" python3 /test/memory-probe.py recall
# PID 1 is s6; SIGTERM must stop its children before Docker's kill deadline.
start=$SECONDS
docker stop --time 20 "$container" >/dev/null
[ $((SECONDS - start)) -lt 20 ]
[ "$(docker inspect -f '{{.State.ExitCode}}' "$container")" = 0 ]
# Back up only after the complete container has cleanly stopped.
"$tests/../scripts/memory-volume.sh" backup "$container" "$scratch/memory.tar.gz"
docker volume create "$restore_volume" >/dev/null
"$tests/../scripts/memory-volume.sh" restore "$container" "$scratch/memory.tar.gz" "$restore_volume"
docker rm "$container" >/dev/null
start_container "$memory_volume"
wait_healthy
docker exec --user 1000:1000 "$container" python3 /test/memory-probe.py recall
docker stop --time 20 "$container" >/dev/null
docker rm "$container" >/dev/null
start_container "$restore_volume"
wait_healthy
docker exec --user 1000:1000 "$container" python3 /test/memory-probe.py recall
docker stop --time 20 "$container" >/dev/null
[ "$(docker inspect -f '{{.State.ExitCode}}' "$container")" = 0 ]
docker rm "$container" >/dev/null
# Missing inference credentials must fail clearly, without echoing values.
mkdir "$scratch/missing"
cp "$scratch"/desktop_* "$scratch/missing/"
docker run -d --name "$container" --mount "type=bind,src=$scratch/missing,dst=/run/secrets,readonly" "$image" >/dev/null
for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Status}}' "$container")" != exited ] || break
    sleep 1
done
[ "$(docker inspect -f '{{.State.Status}}' "$container")" = exited ]
docker logs "$container" 2>&1 | grep -F 'memory: missing runtime secret memory_llm_key'
printf 'Desktop, real Hindsight retain/recall, restart, recreation, offline restore and missing-key diagnostic passed.\n'
