"""Invoke the actual Hermes tool and cua backend, without an LLM or paid inference."""
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import time

os.environ["HERMES_COMPUTER_USE_BACKEND"] = "cua"
sys.path.insert(0, "/opt/hermes")
from tools.computer_use_tool import handle_computer_use, release_computer_use_session, set_approval_callback

session = "agent-box-container-smoke"
set_approval_callback(lambda action, args, summary: "approve_once")


def call(args):
    result = handle_computer_use(args, session_id=session)
    result = json.loads(result) if isinstance(result, str) else result
    if not isinstance(result, dict) or result.get("error") or result.get("ok") is False:
        raise RuntimeError("Hermes computer_use failed for " + args["action"])
    return result


try:
    subprocess.run(["swaymsg", "exec", "foot --title=agent-box-smoke python3 /opt/agent-box/smoke-target.py"], check=True)
    time.sleep(3)
    result = call({"action": "capture", "mode": "vision", "app": "foot"})
    images = [x["image_url"]["url"] for x in result.get("content", []) if x.get("type") == "image_url"]
    if not images:
        raise RuntimeError("Hermes returned no screenshot")
    image = base64.b64decode(images[0].split(",", 1)[1], validate=True)
    if not (image.startswith(b"\x89PNG") or image.startswith(b"\xff\xd8")) or len(image) < 100:
        raise RuntimeError("Invalid screenshot")
    Path("/run/user/1000/smoke-screenshot").write_bytes(image)
    call({"action": "click", "coordinate": [100, 100]})
    call({"action": "type", "text": "hermes-desktop-smoke"})
    call({"action": "key", "keys": "enter"})
    target = Path("/run/user/1000/smoke-input")
    for _ in range(50):
        if target.exists(): break
        time.sleep(0.1)
    if target.read_text() != "hermes-desktop-smoke":
        raise RuntimeError("Typed text did not reach the GUI input sink")
    print("Real Hermes capture/click/type passed")
finally:
    release_computer_use_session(session)
