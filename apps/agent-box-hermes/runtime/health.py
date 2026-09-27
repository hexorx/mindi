"""Readiness requires a real frame and all local desktop listeners."""
import json
import os
import urllib.request
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
    with urllib.request.urlopen('http://127.0.0.1:8888/health', timeout=2) as response:
        if json.load(response).get('status') != 'healthy':
            raise ValueError('Memory database unavailable')
    request = urllib.request.Request('http://127.0.0.1:8642/health',
                                     headers={'Authorization': 'Bearer ' + os.environ['API_SERVER_KEY']})
    with urllib.request.urlopen(request, timeout=2) as response:
        if json.load(response).get('status') != 'ok':
            raise ValueError('Hermes API unavailable')
    for port in (5900, 6080, 8443):
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass
except (OSError, ValueError, KeyError, subprocess.SubprocessError):
    sys.exit(1)
