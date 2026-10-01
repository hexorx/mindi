"""Invoke the actual Hermes tool and cua backend, without an LLM or paid inference."""
import atexit
import base64
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import tempfile

from smoke_result import checked_result

# The test harness can read its private fixtures; uid 1000 cannot read the
# root-owned bind mount. Transfer the redaction corpus only over stdin.
secret_values = json.load(sys.stdin) if sys.argv[1:] == ["--diagnostic-secrets-stdin"] else None

# This program consumes the image itself. Declare native image support in an
# isolated config so Hermes does not send screenshots to auxiliary inference.
# Do not change the operator's persistent profile or mock the tool/backend.
smoke_home = tempfile.TemporaryDirectory(prefix="hermes-desktop-smoke-")
atexit.register(smoke_home.cleanup)
Path(smoke_home.name, "config.yaml").write_text(json.dumps({
    "model": {"supports_vision": True},
    "toolsets": ["computer_use"],
    "computer_use": {"grant_existing_profile": True},
}))
os.environ["HERMES_HOME"] = smoke_home.name
os.environ["HERMES_COMPUTER_USE_BACKEND"] = "cua"
sys.path.insert(0, "/opt/hermes")
from tools.computer_use_tool import handle_computer_use, release_computer_use_session, set_approval_callback

# Regression gate: fail before capture if upstream changes native-image routing.
from tools.computer_use.tool import _should_route_through_aux_vision
if _should_route_through_aux_vision():
    raise RuntimeError("Smoke capture must return images without auxiliary inference")

session = "agent-box-container-smoke"
set_approval_callback(lambda action, args, summary: "approve_once")


def call(args):
    result = handle_computer_use(args, session_id=session)
    return checked_result(result, args["action"], secret_values=secret_values)


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
    # Sway exposes compositor input, not per-window background injection.
    # Explicit foreground delivery lets cua activate and verify our test window.
    call({"action": "click", "coordinate": [100, 100], "delivery_mode": "foreground"})
    call({"action": "type", "text": "hermes-desktop-smoke", "delivery_mode": "foreground"})
    call({"action": "key", "keys": "enter", "delivery_mode": "foreground"})
    target = Path("/run/user/1000/smoke-input")
    for _ in range(50):
        if target.exists(): break
        time.sleep(0.1)
    if target.read_text() != "hermes-desktop-smoke":
        raise RuntimeError("Typed text did not reach the GUI input sink")
    print("Real Hermes capture/click/type passed")
finally:
    release_computer_use_session(session)
