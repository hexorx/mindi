"""Root-only bootstrap; credentials never enter environment variables or logs."""
import os
from pathlib import Path
import shutil
import subprocess


def password_hash(secret):
    password = Path(secret).read_bytes().rstrip(b"\r\n")
    if not 16 <= len(password) <= 256 or any(c in password for c in (b"\n", b"\r", b"\x00")):
        raise ValueError("Desktop password must contain 16–256 bytes on one line")
    return subprocess.run(["openssl", "passwd", "-6", "-stdin"], input=password + b"\n",
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True).stdout


def main():
    if os.environ.get("HERMES_PROFILE") != "default" or os.environ.get("HERMES_HOME") != "/home/agent/.hermes":
        raise ValueError("Only the default profile and fixed home are supported")
    runtime = Path("/run/user/1000")
    runtime.mkdir(parents=True, exist_ok=True)
    runtime.chmod(0o700)
    os.chown(runtime, 1000, 1000)
    subprocess.run(["python3", "/opt/agent-box/memory.py", "prepare"], check=True)
    # /run/secrets is operator-owned; copy secrets only into private ephemeral state.
    for source, target in (("desktop_tls_cert", "tls.crt"), ("desktop_tls_key", "tls.key")):
        path = runtime / target
        shutil.copyfile(Path("/run/secrets") / source, path)
        path.chmod(0o600)
        os.chown(path, 1000, 1000)
    path = runtime / "htpasswd"
    path.write_bytes(b"desktop:" + password_hash("/run/secrets/desktop_password"))
    path.chmod(0o600)
    os.chown(path, 1000, 1000)
    # Validate as the service user, including permissions on all nginx temp paths.
    subprocess.run(["/command/s6-setuidgid", "hermes", "nginx", "-t",
                    "-c", "/etc/agent-box/nginx.conf"], check=True)
    home = Path("/home/agent")
    if home.is_symlink():
        raise ValueError("Home must not be a symlink")
    os.chown(home, 1000, 1000)
    subprocess.run(["/command/s6-setuidgid", "hermes", "python3", "/opt/agent-box/config_sources.py"], check=True)
    subprocess.run(["/command/s6-setuidgid", "hermes", "python3", "/opt/agent-box/memory.py", "configure"], check=True)



if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError):
        raise SystemExit("agent-box: bootstrap failed; check runtime secret files and single-profile volume (values redacted)")
