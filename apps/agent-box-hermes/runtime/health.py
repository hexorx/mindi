"""Readiness requires a real frame and all local desktop listeners."""
import socket
import subprocess
import sys

try:
    frame = subprocess.run(["grim", "-"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                           timeout=3, check=True).stdout
    if not frame.startswith(b"\x89PNG\r\n\x1a\n") or len(frame) < 100:
        raise ValueError("No frame")
    for port in (5900, 6080, 8443):
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass
except (OSError, ValueError, subprocess.SubprocessError):
    sys.exit(1)
