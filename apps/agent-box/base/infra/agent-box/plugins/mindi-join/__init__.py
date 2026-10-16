"""Register /join for Telegram, Buzz, and other Hermes gateway sessions."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

JOIN = Path(os.environ.get("JOIN_LINK_PATH", "/opt/join-link.mjs"))


def _join(raw_args: str) -> str:
    link = raw_args.strip()
    if not link:
        return "Usage: /join <buzz-invite-or-relay-link>"
    try:
        result = subprocess.run(
            ["node", str(JOIN), link],
            capture_output=True,
            text=True,
            timeout=45,
            env=os.environ,
            check=False,
        )
    except FileNotFoundError:
        return "join-link helper is not installed in this image"
    except subprocess.TimeoutExpired:
        return "join timed out"
    text = (result.stdout or result.stderr or "").strip()
    return text or ("joined" if result.returncode == 0 else "join failed")


def register(ctx):
    ctx.register_command(
        "join",
        handler=_join,
        description="Join a Buzz community from an invite or relay link",
        args_hint="<link>",
    )
