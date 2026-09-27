"""Readiness requires a real frame and all local desktop listeners."""
import socket
import subprocess
import sys

try:
    subprocess.run(["swaymsg", "-t", "get_version"], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=3, check=True)
    frame = subprocess.run(["grim", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=3, check=True).stdout
    if not frame.startswith(b"\x89PNG\r\n\x1a\n") or len(frame) < 100:
        raise ValueError("No frame")
    for address in (("127.0.0.2", 5900), ("127.0.0.2", 6080), ("127.0.0.1", 8443)):
        with socket.create_connection(address, timeout=1):
            pass
except (OSError, ValueError, subprocess.SubprocessError):
    sys.exit(1)
