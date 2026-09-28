#!/usr/bin/env bash
# Real userspace Tailscale lifecycle against a disposable Headscale control server:
# enrollment without TUN/NET_ADMIN, identity across restart, revocation, re-enrollment,
# and tailnet reachability limited to the authenticated desktop origin.
set -euo pipefail
image=${1:?Supply the locally built image tag}
headscale_image=headscale/headscale:0.29.4@sha256:8833f828b414c0907b7e5c71da76473216fe17cce0818a166b536ec552c0903f
tailscale_image=tailscale/tailscale:v1.102.4@sha256:2667499ed87ae29218f292556ba062918402dd5e92e93637af14867e4df12dd3
id="ts-smoke-${RANDOM}-${RANDOM}"
net=$id-net box=$id-box peer=$id-peer hs=$id-headscale volume=$id-state
scratch=$(mktemp -d)
tests=$(cd "$(dirname "$0")" && pwd)
cleanup() {
    docker rm -fv "$box" "$peer" "$hs" >/dev/null 2>&1 || true
    docker volume rm "$volume" >/dev/null 2>&1 || true
    docker network rm "$net" >/dev/null 2>&1 || true
    rm -rf "$scratch"
}
trap cleanup EXIT
fail() {
    printf 'FAIL: %s\n' "$1"
    docker logs --tail 100 "$box" 2>&1 || true
    exit 1
}
mkdir -m 700 "$scratch/secrets" "$scratch/headscale"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=localhost \
    -keyout "$scratch/secrets/desktop_tls_key" -out "$scratch/secrets/desktop_tls_cert" >/dev/null 2>&1
# Re-enrollment reconnects quickly; Tailscale may force HTTPS after a recent
# Noise dial. Give the disposable control server real TLS and trust its cert.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=headscale \
    -addext subjectAltName=DNS:headscale \
    -keyout "$scratch/headscale/tls.key" -out "$scratch/headscale/tls.crt" >/dev/null 2>&1
cp "$scratch/headscale/tls.crt" "$scratch/secrets/headscale_ca.crt"
openssl rand -hex 24 > "$scratch/secrets/desktop_password"
printf 'fixture-llm-key' > "$scratch/secrets/memory_llm_key"
printf 'fixture-embedding-key' > "$scratch/secrets/memory_embeddings_key"
cat > "$scratch/headscale/config.yaml" <<'YAML'
server_url: https://headscale:443
listen_addr: 0.0.0.0:443
tls_cert_path: /etc/headscale/tls.crt
tls_key_path: /etc/headscale/tls.key
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
disable_check_updates: true
noise:
  private_key_path: /var/lib/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: false
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  auto_update_enabled: false
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
dns:
  magic_dns: false
  base_domain: agent-box.test
  override_local_dns: false
unix_socket: /var/run/headscale/headscale.sock
unix_socket_permission: "0770"
policy:
  mode: file
  path: ""
YAML

docker network create "$net" >/dev/null
docker run -d --name "$hs" --network "$net" --network-alias headscale \
    --tmpfs /var/lib/headscale:mode=1777 --tmpfs /var/run/headscale:mode=1777 \
    --mount "type=bind,src=$scratch/headscale,dst=/etc/headscale,readonly" \
    "$headscale_image" serve >/dev/null
hsc() { docker exec "$hs" headscale "$@"; }
for _ in $(seq 1 30); do hsc users list -o json >/dev/null 2>&1 && break; sleep 1; done
hsc users create ci >/dev/null
user=$(hsc users list -o json | jq -r '.[] | select(.name == "ci") | .id')
new_key() { hsc preauthkeys create -u "$user" -e 1h -o json | jq -r '.key'; }
install_key() { (umask 077; new_key > "$scratch/secrets/tailscale_authkey"); }

backend() { docker exec "$1" tailscale status --json 2>/dev/null | jq -r '.BackendState' 2>/dev/null || true; }
wait_backend() {
    local state=
    for _ in $(seq 1 60); do
        state=$(backend "$1")
        [ "$state" = "$2" ] && return 0
        sleep 2
    done
    fail "$1 did not reach $2 (last: ${state:-none})"
}
network_health() { docker exec "$box" cat /run/agent-box/network.json | jq -r '.status + "/" + .code'; }
wait_health() {
    local health=
    for _ in $(seq 1 30); do
        health=$(network_health)
        case " $* " in *" $health "*) return 0 ;; esac
        sleep 2
    done
    fail "network health did not reach [$*] (last: $health)"
}
wait_desktop() {
    for _ in $(seq 1 150); do
        [ "$(docker inspect -f '{{.State.Health.Status}}' "$box")" = healthy ] && return 0
        sleep 2
    done
    fail "desktop never became healthy"
}

install_key
docker run -d --name "$box" --network "$net" --shm-size=256m --security-opt=no-new-privileges \
    -e MEMORY_LLM_BASE_URL=http://127.0.0.2:9999/v1 \
    -e MEMORY_EMBEDDINGS_BASE_URL=http://127.0.0.2:9999/v1 \
    --mount "type=bind,src=$tests,dst=/test,readonly" \
    -e SSL_CERT_FILE=/run/secrets/headscale_ca.crt \
    -e AGENT_BOX_TAILSCALE=1 -e AGENT_BOX_TAILSCALE_HOSTNAME=smoke-box \
    -e AGENT_BOX_TAILSCALE_LOGIN_SERVER=https://headscale:443 \
    --mount "type=bind,src=$scratch/secrets,dst=/run/secrets,readonly" \
    --mount "type=volume,src=$volume,dst=/var/lib/tailscale" "$image" >/dev/null

start_fixture() { docker exec -d --user 1000:1000 "$box" python3 /test/mock-memory-provider.py; }
start_fixture

# No TUN device or added capabilities; userspace networking only.
[ "$(docker inspect -f '{{.HostConfig.CapAdd}} {{.HostConfig.Devices}} {{.HostConfig.Privileged}}' "$box")" = "[] [] false" ] \
    || fail "container was granted extra capabilities or devices"
docker exec "$box" sh -c 'test ! -e /dev/net/tun' || fail "/dev/net/tun present"
wait_backend "$box" Running
wait_desktop
first_id=$(docker exec "$box" tailscale status --json | jq -r '.Self.ID')
[ -n "$first_id" ] && [ "$first_id" != null ] || fail "no node identity"
docker exec "$box" tailscale debug prefs | jq -e '
    (.RunSSH | not) and (.RunWebClient | not) and (.ShieldsUp | not)
    and ((.AdvertiseRoutes // []) | length == 0)' >/dev/null || fail "locked preferences not applied"
# Headscale cannot issue tailnet HTTPS certificates, so Serve reports degraded; Funnel/TCP forwards must never appear.
wait_health ready/ok degraded/unavailable
docker exec "$box" tailscale serve status --json | jq -e '
    ((.AllowFunnel // {}) | map(select(.)) | length == 0)
    and (((.TCP // {}) | keys) - ["443"] | length == 0)
    and ([(.TCP // {})[] | .TCPForward // empty] | length == 0)' >/dev/null || fail "unsafe Serve config"

# A second tailnet node may reach only the authenticated HTTPS origin.
docker run -d --name "$peer" --network "$net" -e TS_USERSPACE=true -e TS_HOSTNAME=smoke-peer \
    -e TS_AUTHKEY="$(new_key)" -e TS_EXTRA_ARGS=--login-server=https://headscale:443 \
    -e SSL_CERT_FILE=/run/headscale_ca.crt \
    --mount "type=bind,src=$scratch/headscale/tls.crt,dst=/run/headscale_ca.crt,readonly" \
    -e TS_OUTBOUND_HTTP_PROXY_LISTEN=127.0.0.1:1056 \
    "$tailscale_image" >/dev/null
wait_backend "$peer" Running
box_ip=$(docker exec "$box" tailscale ip -4)
# Use the peer's outbound proxy so the request traverses its tailnet stack.
# HTTPS is required on 8443. CONNECT status also detects open, silent TCP ports.
probe() {
    docker run --rm --network "container:$peer" --entrypoint curl "$image" \
        --silent --insecure --max-time 10 --noproxy '' \
        --proxy http://127.0.0.1:1056 --proxytunnel \
        --output /dev/null --write-out '%{http_connect} %{http_code}' \
        "https://$box_ip:$1/" || true
}
reached=
for _ in $(seq 1 15); do
    [ "$(probe 8443)" = '200 401' ] && { reached=1; break; }
    sleep 2
done
[ -n "$reached" ] || fail "peer could not reach the authenticated desktop origin"
# Discover the actual pg0 port; never assume the allocator chose 5432.
# Positive local probes ensure an absent memory service cannot pass isolation.
pg0_port=$(docker exec "$box" python3 -c '
import json, pathlib, socket
port = json.loads(pathlib.Path("/var/lib/agent-box/hindsight/.pg0/instances/hindsight/instance.json").read_text())["port"]
for private_port in (8888, port):
    with socket.create_connection(("127.0.0.2", private_port), timeout=2):
        pass
print(port)
')
for port in 5900 6080 1055 1056 8888 9999 "$pg0_port"; do
    result=$(probe "$port")
    case "$result" in
        200\ *) fail "tailnet peer reached loopback port $port" ;;
        000\ *|500\ *|502\ *|503\ *|504\ *) ;; # Tailscale returns 500 on refused dials.
        *) fail "unexpected proxy result for port $port: $result" ;;
    esac
done
# A broken peer/proxy must not make the negative probes pass.
[ "$(probe 8443)" = '200 401' ] || fail "peer lost desktop connectivity during exposure checks"

printf 'Exposure checks passed; testing persisted identity.\n'
# Restart without any enrollment key: the persisted node identity is reused.
rm -f "$scratch/secrets/tailscale_authkey"
docker restart -t 20 "$box" >/dev/null
start_fixture
wait_backend "$box" Running
[ "$(docker exec "$box" tailscale status --json | jq -r '.Self.ID')" = "$first_id" ] || fail "identity changed on restart"

printf 'Identity preserved; testing expiry.\n'
# Revocation: expire the node; the box reports not_enrolled while desktop stays up.
node=$(hsc nodes list -o json | jq -r '.[] | select(.given_name == "smoke-box" or .givenName == "smoke-box" or .name == "smoke-box") | .id' | head -n 1)
[ -n "$node" ] || fail "box node not found in Headscale"
hsc nodes expire -i "$node" >/dev/null
wait_backend "$box" NeedsLogin
wait_health not_ready/not_enrolled
wait_desktop

printf 'Expiry and desktop health verified; testing re-enrollment.\n'
# Re-enrollment with a fresh single-use key, without restarting the container.
install_key
wait_backend "$box" Running
wait_health ready/ok degraded/unavailable
wait_desktop
printf 'Userspace Tailscale enrollment, identity, revocation, re-enrollment and exposure checks passed.\n'
