"""Own the single default profile. JSON is a YAML subset accepted by Hermes.

P3 owns this file; arbitrary YAML/remote configuration is deferred to P5.
"""
import json
import os
from pathlib import Path


def configure(home):
    root = Path(home)
    if root.is_symlink():
        raise ValueError("Hermes home must not be a symlink")
    root.mkdir(parents=True, exist_ok=True)
    profiles = root / "profiles"
    if profiles.is_symlink() or (profiles.exists() and any(profiles.iterdir())):
        raise ValueError("Only the root default profile is supported; use a fresh box volume")
    path = root / "config.yaml"
    if path.is_symlink():
        raise ValueError("Configuration must not be a symlink")
    config = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(config, dict):
        raise ValueError("Configuration must be an object")
    toolsets = config.get("toolsets", [])
    computer = config.get("computer_use", {})
    if not isinstance(toolsets, list) or not all(isinstance(x, str) for x in toolsets):
        raise ValueError("toolsets must be a list of strings")
    if not isinstance(computer, dict):
        raise ValueError("computer_use must be an object")
    config["toolsets"] = list(dict.fromkeys([*toolsets, "computer_use"]))
    config["computer_use"] = {**computer, "grant_existing_profile": True}
    temporary = root / ".config.agent-box.tmp"
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as out:
            json.dump(config, out, indent=2)
            out.write("\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        configure(os.environ["HERMES_HOME"])
    except (OSError, ValueError):
        raise SystemExit("agent-box: invalid single-profile configuration (details redacted)")
