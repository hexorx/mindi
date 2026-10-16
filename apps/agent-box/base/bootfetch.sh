#!/bin/sh
# Boot-fetch — stages compose env/files locally before exec'ing the real
# entrypoint. Secrets target is compose, not Infisical.
#
# Optional:
#   AGENTMAIL_API_KEY[_FILE]
#   TELEGRAM_BOT_TOKEN[_FILE]   # skip PLACEHOLDER
#   CODEX_AUTH_JSON[_FILE] plus CODEX_HERMES_AUTH_PATH / CODEX_CLI_AUTH_PATH
#
# Multica (required together if MULTICA_WORKSPACE_ID is set):
#   MULTICA_CONFIG_PATH
#   MULTICA_PAT[_FILE]
#   MULTICA_SERVER_URL / MULTICA_APP_URL
#       optional; default https://app.mindi.dev. APP falls back to SERVER.
#
# AGENT_BOX=1 dest paths (set by the image entrypoint):
#   GITHUB_TOKEN_PATH BUZZ_KEY_PATH BUZZ_RELAY_URL_PATH VNC_PASSWORD_PATH
#   optional GH_REVIEW_TOKEN_PATH GH_PM_TOKEN_PATH
# Sources:
#   GITHUB_TOKEN[_FILE] / GH_TOKEN[_FILE]   (optional)
#   BUZZ_PRIVATE_KEY[_FILE]                 (required)
#   BUZZ_RELAY_URL[_FILE]                   (optional; /join supplies one)
#   VNC_PASSWORD[_FILE]                     (required)
#   GH_REVIEW_TOKEN[_FILE] GH_PM_TOKEN[_FILE] (optional)
#
# After staging, exec "$@" — caller pattern: bootfetch <real cmd> [args...]

set -e

read_secret() {
    # $1=VAR name. Prints value from VAR_FILE or VAR. Empty if unset.
    _name=$1
    _file_var="${_name}_FILE"
    eval "_file=\${${_file_var}:-}"
    if [ -n "$_file" ]; then
        if [ ! -f "$_file" ]; then
            echo "bootfetch: ${_file_var} is set but $_file is missing" >&2
            return 1
        fi
        cat "$_file"
        return 0
    fi
    eval "printf '%s' \"\${${_name}:-}\""
}

stage_file() {
    # $1 dest $2 value
    mkdir -p "$(dirname "$1")"
    printf '%s' "$2" > "$1"
    chmod 600 "$1"
}

if [ -n "${MULTICA_WORKSPACE_ID:-}" ]; then
    : "${MULTICA_CONFIG_PATH:?bootfetch: MULTICA_CONFIG_PATH not set}"
fi

if [ "${AGENT_BOX:-}" = "1" ]; then
    : "${GITHUB_TOKEN_PATH:?bootfetch: GITHUB_TOKEN_PATH not set}"
    : "${BUZZ_KEY_PATH:?bootfetch: BUZZ_KEY_PATH not set}"
    : "${BUZZ_RELAY_URL_PATH:?bootfetch: BUZZ_RELAY_URL_PATH not set}"
    : "${VNC_PASSWORD_PATH:?bootfetch: VNC_PASSWORD_PATH not set}"
fi

AGENTMAIL_API_KEY=$(read_secret AGENTMAIL_API_KEY)
[ -n "$AGENTMAIL_API_KEY" ] && export AGENTMAIL_API_KEY

TELEGRAM_BOT_TOKEN=$(read_secret TELEGRAM_BOT_TOKEN)
if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ "$TELEGRAM_BOT_TOKEN" != "PLACEHOLDER" ]; then
    export TELEGRAM_BOT_TOKEN
else
    unset TELEGRAM_BOT_TOKEN
fi

if [ -n "${MULTICA_WORKSPACE_ID:-}" ]; then
    MULTICA_PAT=$(read_secret MULTICA_PAT)
    if [ -z "$MULTICA_PAT" ]; then
        echo "bootfetch: MULTICA_PAT not set" >&2
        exit 1
    fi

    MULTICA_SERVER_URL="${MULTICA_SERVER_URL:-https://app.mindi.dev}"
    MULTICA_APP_URL="${MULTICA_APP_URL:-$MULTICA_SERVER_URL}"

    mkdir -p "$(dirname "$MULTICA_CONFIG_PATH")"
    cat > "$MULTICA_CONFIG_PATH" <<EOF
{"server_url":"$MULTICA_SERVER_URL","app_url":"$MULTICA_APP_URL","workspace_id":"$MULTICA_WORKSPACE_ID","token":"$MULTICA_PAT"}
EOF
    chmod 600 "$MULTICA_CONFIG_PATH"
    echo "bootfetch: staged Multica config at $MULTICA_CONFIG_PATH" >&2
fi

if [ "${AGENT_BOX:-}" = "1" ]; then
    GH_PAT=$(read_secret GITHUB_TOKEN)
    if [ -z "$GH_PAT" ]; then
        GH_PAT=$(read_secret GH_TOKEN)
    fi
    if [ -n "$GH_PAT" ]; then
        stage_file "$GITHUB_TOKEN_PATH" "$GH_PAT"
        export GH_TOKEN="$GH_PAT"
        export GITHUB_TOKEN="$GH_PAT"
    else
        echo "bootfetch: no GitHub token yet (onboarding will supply one)" >&2
    fi

    REVIEW_TOK=$(read_secret GH_REVIEW_TOKEN)
    if [ -n "$REVIEW_TOK" ] && [ -n "${GH_REVIEW_TOKEN_PATH:-}" ]; then
        stage_file "$GH_REVIEW_TOKEN_PATH" "$REVIEW_TOK"
        export GH_REVIEW_TOKEN="$REVIEW_TOK"
    fi
    PM_TOK=$(read_secret GH_PM_TOKEN)
    if [ -n "$PM_TOK" ] && [ -n "${GH_PM_TOKEN_PATH:-}" ]; then
        stage_file "$GH_PM_TOKEN_PATH" "$PM_TOK"
        export GH_PM_TOKEN="$PM_TOK"
    fi

    BUZZ_KEY=$(read_secret BUZZ_PRIVATE_KEY)
    [ -n "$BUZZ_KEY" ] || { echo "bootfetch: BUZZ_PRIVATE_KEY not set" >&2; exit 1; }
    stage_file "$BUZZ_KEY_PATH" "$BUZZ_KEY"
    export BUZZ_PRIVATE_KEY="$BUZZ_KEY"

    BUZZ_RELAY=$(read_secret BUZZ_RELAY_URL)
    if [ -n "$BUZZ_RELAY" ]; then
        stage_file "$BUZZ_RELAY_URL_PATH" "$BUZZ_RELAY"
        export BUZZ_RELAY_URL="$BUZZ_RELAY"
    else
        echo "bootfetch: no Buzz relay yet (/join will supply one)" >&2
        unset BUZZ_RELAY_URL
    fi

    VNC_PASS=$(read_secret VNC_PASSWORD)
    [ -n "$VNC_PASS" ] || { echo "bootfetch: VNC_PASSWORD not set" >&2; exit 1; }
    stage_file "$VNC_PASSWORD_PATH" "$VNC_PASS"
fi

echo "bootfetch: staged AgentMail (len=${#AGENTMAIL_API_KEY}), Telegram (len=${#TELEGRAM_BOT_TOKEN})" >&2

# Codex OAuth staging — seed Hermes auth.json and/or Codex CLI auth.json from
# compose. Existing openai-codex entries are NEVER overwritten — locally
# refreshed tokens on disk win. First-boot / disaster-recovery only.
if [ -n "${CODEX_HERMES_AUTH_PATH:-}" ] || [ -n "${CODEX_CLI_AUTH_PATH:-}" ]; then
    CODEX_AUTH_JSON=$(read_secret CODEX_AUTH_JSON)
    if [ -z "$CODEX_AUTH_JSON" ]; then
        echo "bootfetch: WARN no CODEX_AUTH_JSON (skipping)" >&2
    else
        export CODEX_AUTH_JSON CODEX_HERMES_AUTH_PATH CODEX_CLI_AUTH_PATH
        python3 <<'PYEOF' >&2
import json, os, pathlib

src = json.loads(os.environ["CODEX_AUTH_JSON"])
tokens = src["tokens"]
last_refresh = src.get("last_refresh")
auth_mode = src.get("auth_mode", "chatgpt")

def write_atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2))
    tmp.chmod(0o600)
    tmp.replace(path)

hp = os.environ.get("CODEX_HERMES_AUTH_PATH") or ""
if hp:
    p = pathlib.Path(hp)
    if p.exists():
        cur = json.loads(p.read_text())
    else:
        cur = {"version": 1, "providers": {}, "credential_pool": {}, "updated_at": None, "active_provider": None}
    cur.setdefault("providers", {})
    cur.setdefault("credential_pool", {})
    if "openai-codex" not in cur["providers"]:
        cur["providers"]["openai-codex"] = {
            "tokens": tokens,
            "last_refresh": last_refresh,
            "auth_mode": auth_mode,
        }
        cur["credential_pool"]["openai-codex"] = [{
            "id": "compose",
            "label": "compose-seed",
            "auth_type": "oauth",
            "priority": 0,
            "source": "compose",
            "access_token": tokens["access_token"],
            "refresh_token": tokens["refresh_token"],
            "last_status": None,
            "last_status_at": None,
            "last_error_code": None,
            "last_error_reason": None,
            "last_error_message": None,
            "last_error_reset_at": None,
            "base_url": "https://chatgpt.com/backend-api/codex",
            "last_refresh": last_refresh,
            "request_count": 0,
        }]
        if not cur.get("active_provider"):
            cur["active_provider"] = "openai-codex"
        write_atomic(p, cur)
        print(f"bootfetch: seeded codex into Hermes auth.json at {p}")
    else:
        print(f"bootfetch: Hermes codex entry already present at {p} (leaving alone)")

cp = os.environ.get("CODEX_CLI_AUTH_PATH") or ""
if cp:
    p = pathlib.Path(cp)
    already = False
    if p.exists():
        try:
            cur = json.loads(p.read_text())
            if cur.get("tokens"):
                already = True
        except json.JSONDecodeError:
            pass
    if already:
        print(f"bootfetch: Codex CLI auth already present at {p} (leaving alone)")
    else:
        write_atomic(p, {"OPENAI_API_KEY": None, "tokens": tokens, "last_refresh": last_refresh})
        print(f"bootfetch: seeded Codex CLI auth at {p}")
PYEOF
    fi
fi

exec "$@"
