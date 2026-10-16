#!/bin/sh
# Hindsight API (pg0 under $HOME). Unconfigured boxes wait without restarting.
set -e
ENV_FILE="${AGENT_BOX_ENV_PATH:-/run/agent-box.env}"
WAITING="${AGENT_BOX_RUN_DIR:-/run/agent-box}/waiting-hindsight"
while :; do
    set -a
    [ ! -f "$ENV_FILE" ] || . "$ENV_FILE"
    set +a
    case "${HINDSIGHT_ENABLED:-auto}" in
        1|true) break ;;
        auto) [ -z "${HINDSIGHT_API_LLM_API_KEY:-}" ] || break ;;
        0|false) ;;
        *) echo "hindsight: HINDSIGHT_ENABLED must be auto, 1 or 0" >&2; exit 2 ;;
    esac
    if [ ! -f "$WAITING" ]; then
        mkdir -p "$(dirname "$WAITING")"
        printf '%s\n' "Hindsight is disabled or awaiting configuration; set HINDSIGHT_ENABLED=1 after configuring memory." > "$WAITING"
        echo "hindsight: waiting for memory configuration" >&2
    fi
    sleep 30
done
rm -f "$WAITING"
export HOME="${HOME:-/home/agent}"
export USER="${USER:-hermes}"
export HINDSIGHT_API_HOST="${HINDSIGHT_API_HOST:-127.0.0.1}"
export HINDSIGHT_API_PORT="${HINDSIGHT_API_PORT:-8888}"
export HINDSIGHT_API_BASE_PATH="${HINDSIGHT_API_BASE_PATH:-/api}"
export HINDSIGHT_API_RUN_MIGRATIONS_ON_STARTUP="${HINDSIGHT_API_RUN_MIGRATIONS_ON_STARTUP:-true}"
export HINDSIGHT_API_DATABASE_URL="${HINDSIGHT_API_DATABASE_URL:-pg0}"
export HINDSIGHT_API_EMBEDDINGS_PROVIDER="${HINDSIGHT_API_EMBEDDINGS_PROVIDER:-openai}"
export HINDSIGHT_API_RERANKER_PROVIDER="${HINDSIGHT_API_RERANKER_PROVIDER:-rrf}"
if [ -z "${HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY:-}" ] && [ -n "${HINDSIGHT_API_LLM_API_KEY:-}" ]; then
    export HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY="${HINDSIGHT_API_LLM_API_KEY}"
fi
if [ -z "${HINDSIGHT_API_LLM_BASE_URL:-}" ]; then
    unset HINDSIGHT_API_LLM_BASE_URL
fi
exec "${HINDSIGHT_BIN:-/opt/hindsight/bin/hindsight-api}"
