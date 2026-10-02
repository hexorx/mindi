#!/usr/bin/env bash
set -Eeuo pipefail
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
# Report the failing location without tracing commands or credential values.
trap 'printf "Container smoke failed at line %s (exit %s)\n" "$LINENO" "$?" >&2' ERR
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
docker volume create "$home_volume" >/dev/null
docker volume create "$memory_volume" >/dev/null
start_container() {
    docker run -d --name "$container" --shm-size=256m --security-opt=no-new-privileges \
        -e API_SERVER_KEY=fixture-only-api-key-for-smoke \
        -e PAPERCLIP_CALLBACK_KEY=fixture-only-callback-key-for-smoke \
        -e PAPERCLIP_API_URL=http://paperclip.invalid/api \
        --mount "type=volume,src=$home_volume,dst=/home/agent" \
        --mount "type=volume,src=$1,dst=/var/lib/agent-box/hindsight" \
        --mount "type=bind,src=$tests,dst=/test,readonly" \
        -p 127.0.0.1::8443 --mount "type=bind,src=$scratch,dst=/run/secrets,readonly" "$image" >/dev/null
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
# Tailscale is off by default: no daemon, disabled network health, desktop and memory off forwarded loopback.
docker exec --user 1000:1000 "$container" python3 -c '
import json, pathlib, socket
assert json.loads(pathlib.Path("/run/agent-box/network.json").read_text()) == {"status": "disabled", "code": "disabled"}
assert not any(p.read_text().strip() == "tailscaled" for p in pathlib.Path("/proc").glob("[0-9]*/comm"))
for port in (5900, 6080):
    with socket.create_connection(("127.0.0.2", port), timeout=1):
        pass
for port in (5900, 6080, 1055, 1056, 8888):
    with socket.socket() as s:
        s.settimeout(1)
        assert s.connect_ex(("127.0.0.1", port)) != 0, port
'
port=$(docker port "$container" 8443/tcp | sed 's/.*://')
base="https://127.0.0.1:$port"
# Real supervised API auth through the single TLS entrypoint; no model call.
bash "$tests/api-ingress-smoke.sh" "$base" "$scratch/desktop_tls_cert" fixture-only-api-key-for-smoke
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
# Real boot consumes packaged defaults without GitHub. Refresh and rollback swap
# the model and persona together without modifying desktop security settings.
docker exec -i --user 1000:1000 "$container" python3 - <<'PYTHON'
import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, '/opt/agent-box')
from config_sources import apply
home = Path('/home/agent/.hermes')
assert json.loads((home / '.agent-box/status.json').read_text())['source'] == 'defaults'
original = (home / 'AGENTS.md').read_text()
with tempfile.TemporaryDirectory() as local:
    root = Path(local)
    (root / 'agent-box.yaml').write_text('schemaVersion: 1\nflavor: hermes\nhermes: {model: fixture-model}\npersona: {instructionsFile: AGENTS.md}\n')
    (root / 'AGENTS.md').write_text('Fixture persona')
    apply(home, local=local, refresh=True)
    config = json.loads((home / 'config.yaml').read_text())
    assert config['model'] == 'fixture-model'
    assert config['computer_use']['grant_existing_profile'] is True
    assert (home / 'AGENTS.md').read_text() == 'Fixture persona'
    apply(home, rollback=True)
    assert (home / 'AGENTS.md').read_text() == original
PYTHON
# Keep the fixture directory private. Supply its complete redaction corpus via
# stdin, never argv, environment, logs, or a new container file.
python3 - "$scratch" <<'PYTHON' | docker exec -i --user 1000:1000 "$container" /opt/hermes/.venv/bin/python /opt/agent-box/smoke.py --diagnostic-secrets-stdin
import json, pathlib, sys
json.dump([p.read_text().strip() for p in pathlib.Path(sys.argv[1]).iterdir() if p.is_file()], sys.stdout)
PYTHON
# Built-in memory persists in the home; no database or embedding provider starts.
docker exec --user 1000:1000 "$container" /opt/hermes/.venv/bin/python /test/file-memory-probe.py write
docker restart --time 20 "$container" >/dev/null
wait_healthy
docker exec --user 1000:1000 "$container" /opt/hermes/.venv/bin/python /test/file-memory-probe.py read
start=$SECONDS
docker stop --time 20 "$container" >/dev/null
[ $((SECONDS - start)) -lt 20 ]
[ "$(docker inspect -f '{{.State.ExitCode}}' "$container")" = 0 ]
printf 'Desktop, computer use, key-free file memory, restart and graceful stop passed.\n'
