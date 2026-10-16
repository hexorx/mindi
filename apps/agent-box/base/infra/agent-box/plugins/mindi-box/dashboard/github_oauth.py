"""GitHub device flow for the mindi-box dashboard plugin."""

from __future__ import annotations

import json
import uuid
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

SCOPES = "repo read:user workflow"
DEVICE_URL = "https://github.com/login/device/code"
TOKEN_URL = "https://github.com/login/oauth/access_token"
USER_URL = "https://api.github.com/user"

_SESSIONS: dict[str, dict[str, Any]] = {}


def token_path(env: dict[str, str]) -> Path:
    return Path(
        env.get("GITHUB_TOKEN_PATH")
        or f"{env.get('HOME', '/home/agent')}/.secrets/github-token",
    )


def _http_json(
    method: str,
    url: str,
    *,
    data: dict[str, str] | None = None,
    token: str | None = None,
    http: dict[tuple[str, str], Any] | None = None,
) -> dict[str, Any]:
    if http is not None:
        return dict(http[(method, url)])
    headers = {"Accept": "application/json", "User-Agent": "mindi-box"}
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode() if exc.fp else ""
        try:
            return json.loads(raw) if raw else {"error": f"http_{exc.code}"}
        except json.JSONDecodeError:
            return {"error": f"http_{exc.code}"}


def start_device(
    env: dict[str, str],
    http: dict[tuple[str, str], Any] | None = None,
) -> dict[str, Any]:
    client_id = (env.get("GITHUB_OAUTH_CLIENT_ID") or "").strip()
    if not client_id:
        return {"ok": False, "error": "missing_client_id"}
    payload = _http_json(
        "POST",
        DEVICE_URL,
        data={"client_id": client_id, "scope": SCOPES},
        http=http,
    )
    if payload.get("error") or not payload.get("device_code"):
        return {"ok": False, "error": payload.get("error") or "device_start_failed"}
    poll_id = str(uuid.uuid4())
    _SESSIONS[poll_id] = {
        "device_code": payload["device_code"],
        "interval": int(payload.get("interval") or 5),
    }
    return {
        "ok": True,
        "user_code": payload["user_code"],
        "verification_uri": payload.get("verification_uri")
        or "https://github.com/login/device",
        "expires_in": int(payload.get("expires_in") or 900),
        "interval": int(payload.get("interval") or 5),
        "poll_id": poll_id,
    }


def write_token(path: Path, token: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{token}\n", encoding="utf-8")
    path.chmod(0o600)


def poll_device(
    env: dict[str, str],
    body: dict[str, Any],
    http: dict[tuple[str, str], Any] | None = None,
) -> dict[str, Any]:
    poll_id = str(body.get("poll_id") or "")
    session = _SESSIONS.get(poll_id)
    if not session:
        return {"status": "error", "error": "unknown_poll_id"}
    client_id = (env.get("GITHUB_OAUTH_CLIENT_ID") or "").strip()
    payload = _http_json(
        "POST",
        TOKEN_URL,
        data={
            "client_id": client_id,
            "device_code": session["device_code"],
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
        },
        http=http,
    )
    err = payload.get("error")
    if err == "authorization_pending":
        return {"status": "pending"}
    if err == "slow_down":
        interval = int(payload.get("interval") or session["interval"] + 5)
        session["interval"] = interval
        return {"status": "pending", "interval": interval}
    if err:
        _SESSIONS.pop(poll_id, None)
        return {"status": "error", "error": err}
    token = str(payload.get("access_token") or "").strip()
    if not token:
        _SESSIONS.pop(poll_id, None)
        return {"status": "error", "error": "missing_access_token"}
    user = _http_json("GET", USER_URL, token=token, http=http)
    login = str(user.get("login") or "")
    expected = (env.get("GITHUB_OWNER") or env.get("PERSONA_NAME") or "").strip()
    if not login or not expected or login.lower() != expected.lower():
        _SESSIONS.pop(poll_id, None)
        return {
            "status": "wrong_account",
            "login": login,
            "expected": expected,
        }
    path = token_path(env)
    replaced = path.is_file() and path.stat().st_size > 0
    write_token(path, token)
    _SESSIONS.pop(poll_id, None)
    return {"status": "ok", "login": login, "replaced": replaced}
