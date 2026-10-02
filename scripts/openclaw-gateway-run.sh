#!/usr/bin/env bash
# Foreground gateway. scripts/openclaw-up.sh starts this under tmux.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/openclaw/bin:${PATH}"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-${ROOT}/runs/openclaw/state}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${ROOT}/runs/openclaw/openclaw.json}"
export OPENCLAW_DESK_INBOX="${OPENCLAW_DESK_INBOX:-${ROOT}/runs/openclaw/inbox.jsonl}"
token="$(cat "${ROOT}/runs/openclaw/gateway.token")"
exec openclaw gateway run --bind loopback --port 18789 --auth token --token "$token"
