"""Optional userspace Tailscale, supervised independently of the desktop.

Lifecycle reference: mindi-stack 3ae5dec start-tailscale.sh (see docs/extraction-provenance.md).
No TUN device or NET_ADMIN is needed. Node state lives in its own root-owned volume, never the
agent home. Only the authenticated desktop origin is published, through private Serve. Funnel,
Tailscale SSH, the web client, subnet routes and exit-node advertising are forced off on every start.
The enrollment key is passed to the CLI by path and never enters argv, environment or logs.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

STATE_DIR = Path("/var/lib/tailscale")
STATUS_FILE = Path("/run/agent-box/network.json")
DEFAULT_KEY_FILE = "/run/secrets/tailscale_authkey"
ENROLLED_MARKER = "agent-box-enrolled"
SERVE_TARGET = "https+insecure://127.0.0.1:8443"
SERVE_PORT = "443"
POLL_SECONDS = 10
SERVE_RETRY_SECONDS = 300
HOSTNAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
LOGIN_SERVER = re.compile(r"^https?://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/?$")
UP_PREFS = ["--ssh=false", "--shields-up=false", "--advertise-exit-node=false",
            "--advertise-routes=", "--accept-routes=false", "--accept-dns=false"]
# The pinned CLI exposes webclient only on set, not up.
LOCKED_PREFS = [*UP_PREFS, "--webclient=false"]


class ConfigError(ValueError):
    pass


def load_config(env):
    enabled = env.get("AGENT_BOX_TAILSCALE", "0").strip().lower()
    if enabled in ("", "0", "false"):
        return {"enabled": False}
    if enabled not in ("1", "true"):
        raise ConfigError("AGENT_BOX_TAILSCALE must be 0/false or 1/true")
    hostname = env.get("AGENT_BOX_TAILSCALE_HOSTNAME", "")
    if hostname and not HOSTNAME.match(hostname):
        raise ConfigError("AGENT_BOX_TAILSCALE_HOSTNAME must be a lowercase DNS label")
    login_server = env.get("AGENT_BOX_TAILSCALE_LOGIN_SERVER", "")
    if login_server and not LOGIN_SERVER.match(login_server):
        raise ConfigError("AGENT_BOX_TAILSCALE_LOGIN_SERVER must be a bare http(s) origin")
    key_file = env.get("TS_AUTHKEY_FILE", DEFAULT_KEY_FILE)
    if not key_file.startswith("/"):
        raise ConfigError("TS_AUTHKEY_FILE must be an absolute path")
    return {"enabled": True, "hostname": hostname, "login_server": login_server, "key_file": key_file}


def write_status(path, status, code):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps({"status": status, "code": code}) + "\n")
    temp.chmod(0o644)
    os.replace(temp, path)


def prepare_state_dir(path, ismount=os.path.ismount, chown=os.chown):
    path = Path(path)
    if path.is_symlink():
        raise ConfigError("Tailscale state must not be a symlink")
    if not ismount(str(path)):
        raise ConfigError("Tailscale state needs its own persistent volume at " + str(path))
    path.chmod(0o700)
    chown(path, 0, 0)


def enroll_args(config):
    args = ["up", "--reset", "--timeout=60s", *UP_PREFS]
    if config["hostname"]:
        args.append("--hostname=" + config["hostname"])
    if config["login_server"]:
        args.append("--login-server=" + config["login_server"])
    return args


def serve_config_is_private(serve):
    """Accept only one HTTPS listener proxying to the authenticated desktop origin."""
    if not isinstance(serve, dict):
        return False
    if any(value for key, value in serve.items() if key not in ("TCP", "Web")):
        return False  # AllowFunnel, Services, Foreground or anything unknown
    if serve.get("TCP") != {SERVE_PORT: {"HTTPS": True}}:
        return False
    web = serve.get("Web")
    if not isinstance(web, dict) or len(web) != 1:
        return False
    host, site = next(iter(web.items()))
    return host.endswith(":" + SERVE_PORT) and site == {"Handlers": {"/": {"Proxy": SERVE_TARGET}}}


def key_digest(path):
    try:
        data = Path(path).read_bytes().strip()
    except OSError:
        return None
    return hashlib.sha256(data).hexdigest() if data else None


class Manager:
    """One reconcile pass per poll; CLI access is injected for tests."""

    def __init__(self, config, cli, state_dir=STATE_DIR, status_file=STATUS_FILE, log=None,
                 clock=time.monotonic):
        self.config = config
        self.cli = cli
        self.state_dir = Path(state_dir)
        self.status_file = Path(status_file)
        self.log = log or (lambda message: print("agent-box tailscale: " + message, file=sys.stderr))
        self.clock = clock
        self.serve_retry_at = 0
        self.tried_key = None
        self.key_rejected = False
        self.prefs_locked = False
        self.restarted_from_stopped = False
        self.last = None

    def status(self, status, code):
        if self.last != (status, code):
            self.log(status + "/" + code)
            self.last = (status, code)
        write_status(self.status_file, status, code)

    @property
    def enrolled_before(self):
        return (self.state_dir / ENROLLED_MARKER).exists()

    def reconcile(self):
        result = self.cli(["status", "--json"])
        if result.returncode != 0:
            return self.status("not_ready", "starting")
        backend = json.loads(result.stdout or "{}").get("BackendState", "")
        if backend == "Running":
            return self.running()
        self.prefs_locked = False
        if backend in ("NeedsLogin", "NoState"):
            return self.needs_login()
        if backend == "Stopped" and not self.restarted_from_stopped:
            self.restarted_from_stopped = True
            self.cli(enroll_args(self.config))
            return self.status("not_ready", "starting")
        if backend == "NeedsMachineAuth":
            return self.status("not_ready", "not_enrolled")
        return self.status("not_ready", "starting")

    def needs_login(self):
        digest = key_digest(self.config["key_file"])
        if digest is None:
            return self.status("not_ready", "not_enrolled" if self.enrolled_before else "credential_missing")
        if digest != self.tried_key:
            # Each distinct key is tried once; single-use keys cannot be replayed anyway.
            self.tried_key = digest
            result = self.cli([*enroll_args(self.config), "--auth-key=file:" + self.config["key_file"]])
            self.key_rejected = result.returncode != 0
            if not self.key_rejected:
                return self.running()
        # A key that already enrolled this node was consumed; revocation needs a new one.
        return self.status("not_ready", "unauthorized" if self.key_rejected else "not_enrolled")

    def running(self):
        marker = self.state_dir / ENROLLED_MARKER
        if not marker.exists():
            marker.touch(mode=0o600)
        if not self.prefs_locked:
            self.prefs_locked = self.cli(["set", *LOCKED_PREFS]).returncode == 0
        if not self.prefs_locked:
            return self.status("degraded", "unavailable")
        if not self.serve_is_private():
            # Never leave a partial or foreign Serve/Funnel config published.
            self.cli(["serve", "reset"])
            if self.clock() < self.serve_retry_at:
                return self.status("degraded", "unavailable")
            self.cli(["serve", "--bg", "--yes", "--https=" + SERVE_PORT, SERVE_TARGET])
            if not self.serve_is_private():
                self.cli(["serve", "reset"])
                self.serve_retry_at = self.clock() + SERVE_RETRY_SECONDS
                return self.status("degraded", "unavailable")
        return self.status("ready", "ok")

    def serve_is_private(self):
        result = self.cli(["serve", "status", "--json"])
        if result.returncode != 0:
            return False
        try:
            return serve_config_is_private(json.loads(result.stdout or "{}"))
        except ValueError:
            return False


def cli(args, timeout=90):
    try:
        return subprocess.run(["tailscale", *args], stdin=subprocess.DEVNULL, capture_output=True,
                              text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", "")


def pause(status, code, message=None):
    """Idle without restart loops; s6 would otherwise respawn an exiting longrun."""
    write_status(STATUS_FILE, status, code)
    if message:
        print("agent-box tailscale: " + message, file=sys.stderr)
    os.execv("/command/s6-pause", ["s6-pause"])


def daemon_args():
    # Userspace mode does not route egress, so callers reach tailnet-only URLs through these
    # proxies. Not 127.0.0.1: tailnet peers could otherwise use them as an open relay.
    return ["tailscaled", "--tun=userspace-networking", "--statedir=" + str(STATE_DIR),
            "--socks5-server=127.0.0.2:1055", "--outbound-http-proxy-listen=127.0.0.2:1056"]


def main(env=os.environ):
    try:
        config = load_config(env)
        if not config["enabled"]:
            return pause("disabled", "disabled")
        prepare_state_dir(STATE_DIR)
    except ConfigError as error:
        return pause("not_ready", "unavailable", str(error))
    write_status(STATUS_FILE, "not_ready", "starting")
    daemon = subprocess.Popen(daemon_args(), stdin=subprocess.DEVNULL)

    def stop(*_):
        daemon.terminate()
        try:
            daemon.wait(8)
        except subprocess.TimeoutExpired:
            daemon.kill()
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    manager = Manager(config, cli)
    while daemon.poll() is None:
        try:
            manager.reconcile()
        except (OSError, ValueError):
            manager.status("degraded", "unavailable")
        time.sleep(POLL_SECONDS)
    write_status(STATUS_FILE, "not_ready", "unavailable")
    # Exit so s6 restarts only this service; desktop and memory keep running.
    sys.exit(1)


if __name__ == "__main__":
    main()
