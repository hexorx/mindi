"""Box status, GitHub device flow, and noVNC reverse-proxy for the dashboard plugin."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

_DASHBOARD_DIR = Path(__file__).resolve().parent
if str(_DASHBOARD_DIR) not in sys.path:
    sys.path.insert(0, str(_DASHBOARD_DIR))

from github_oauth import poll_device, start_device

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, Response

router = APIRouter()

NOVNC = "http://127.0.0.1:6080"
HINDSIGHT = "http://127.0.0.1:8888/api/health"


def token_path() -> Path:
    return Path(
        os.environ.get("GITHUB_TOKEN_PATH")
        or f"{os.environ.get('HOME', '/home/agent')}/.secrets/github-token",
    )


def probe(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=2) as res:
            return "ok" if 200 <= res.status < 400 else f"http {res.status}"
    except Exception as exc:  # noqa: BLE001 — status surface, not control flow
        return f"unreachable ({type(exc).__name__})"


def gh_login() -> tuple[bool, str | None]:
    path = token_path()
    if not path.is_file() or path.stat().st_size == 0:
        return False, None
    env = os.environ.copy()
    env["GH_TOKEN"] = path.read_text(encoding="utf-8").strip()
    env["GITHUB_TOKEN"] = env["GH_TOKEN"]
    try:
        out = subprocess.run(
            ["gh", "api", "user", "--jq", ".login"],
            check=False,
            capture_output=True,
            text=True,
            timeout=8,
            env=env,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return True, None
    if out.returncode != 0:
        return True, None
    login = out.stdout.strip() or None
    return True, login


@router.get("/status")
async def status() -> dict[str, object]:
    owner = os.environ.get("GITHUB_OWNER") or os.environ.get("PERSONA_NAME") or ""
    has_token, login = await asyncio.to_thread(gh_login)
    return {
        "githubOwner": owner,
        "personaRepo": f"{owner}/{owner}" if owner else "",
        "dotfilesRepo": f"{owner}/dotfiles" if owner else "",
        "hasToken": has_token,
        "ghLogin": login,
        "hindsight": await asyncio.to_thread(probe, HINDSIGHT),
        "novnc": await asyncio.to_thread(probe, f"{NOVNC}/vnc.html"),
    }


@router.post("/github-token")
async def write_github_token(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return JSONResponse({"ok": False, "error": "invalid_json"}, status_code=400)
    token = str(body.get("token") or "").strip()
    if not token:
        return JSONResponse({"ok": False, "error": "empty_token"}, status_code=400)
    path = token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{token}\n", encoding="utf-8")
    path.chmod(0o600)
    return JSONResponse({"ok": True})


@router.post("/github-oauth/start")
async def github_oauth_start() -> JSONResponse:
    result = await asyncio.to_thread(start_device, dict(os.environ))
    if not result.get("ok"):
        return JSONResponse(result, status_code=503)
    return JSONResponse(result)


@router.post("/github-oauth/poll")
async def github_oauth_poll(request: Request) -> JSONResponse:
    try:
        body = await request.json()
    except json.JSONDecodeError:
        return JSONResponse({"status": "error", "error": "invalid_json"}, status_code=400)
    result = await asyncio.to_thread(poll_device, dict(os.environ), body)
    return JSONResponse(result)


def _novnc_url(path: str, query: str) -> str:
    stripped = path.lstrip("/")
    url = f"{NOVNC}/{stripped}" if stripped else f"{NOVNC}/"
    if query:
        url = f"{url}?{query}"
    return url


@router.api_route("/novnc", methods=["GET", "HEAD"], include_in_schema=False)
@router.api_route("/novnc/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
async def novnc_http(request: Request, path: str = "") -> Response:
    url = _novnc_url(path, str(request.query_params))

    def fetch() -> tuple[bytes, str, int]:
        try:
            with urllib.request.urlopen(url, timeout=10) as res:
                ctype = res.headers.get("content-type") or "application/octet-stream"
                return res.read(), ctype, res.status
        except urllib.error.HTTPError as exc:
            body = exc.read() if exc.fp else b""
            ctype = exc.headers.get("content-type") if exc.headers else "text/plain"
            return body, ctype or "text/plain", exc.code

    body, ctype, status_code = await asyncio.to_thread(fetch)
    return Response(content=body, media_type=ctype, status_code=status_code)


@router.websocket("/websockify")
async def novnc_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        import websockets
    except ImportError:
        await websocket.close(code=1011)
        return
    upstream = await websockets.connect("ws://127.0.0.1:6080/websockify")

    async def client_to_upstream() -> None:
        try:
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                data = message.get("bytes")
                if data is not None:
                    await upstream.send(data)
                    continue
                text = message.get("text")
                if text is not None:
                    await upstream.send(text)
        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    async def upstream_to_client() -> None:
        try:
            async for data in upstream:
                if isinstance(data, bytes):
                    await websocket.send_bytes(data)
                else:
                    await websocket.send_text(data)
        except Exception:
            pass

    try:
        await asyncio.gather(client_to_upstream(), upstream_to_client())
    finally:
        await upstream.close()
