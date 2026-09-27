#!/usr/bin/env bash
set -euo pipefail
image=${1:?Supply the locally built image tag}
scratch=$(mktemp -d)
container="hermes-smoke-${RANDOM}-${RANDOM}"
cleanup() {
    docker rm -fv "$container" >/dev/null 2>&1 || true
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
docker run -d --name "$container" --shm-size=256m --security-opt=no-new-privileges \
    -p 127.0.0.1::8443 --mount "type=bind,src=$scratch,dst=/run/secrets,readonly" "$image" >/dev/null
for _ in $(seq 1 60); do
    state=$(docker inspect -f '{{.State.Status}}' "$container")
    if [ "$state" = exited ] || [ "$state" = dead ]; then
        docker logs "$container"
        exit 1
    fi
    health=$(docker inspect -f '{{.State.Health.Status}}' "$container")
    [ "$health" != healthy ] || break
    sleep 2
done
if [ "$health" != healthy ]; then
    docker logs "$container"
    exit 1
fi
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
# PID 1 is s6; SIGTERM must stop its children before Docker's kill deadline.
start=$SECONDS
docker stop --time 20 "$container" >/dev/null
[ $((SECONDS - start)) -lt 20 ]
[ "$(docker inspect -f '{{.State.ExitCode}}' "$container")" = 0 ]
printf 'Authenticated desktop, real Hermes computer-use, and graceful shutdown passed.\n'
