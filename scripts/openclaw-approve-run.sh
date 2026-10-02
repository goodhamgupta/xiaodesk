#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/openclaw/bin:${PATH}"
export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-${ROOT}/runs/openclaw/state}"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-${ROOT}/runs/openclaw/openclaw.json}"
export OPENCLAW_BIN=/opt/openclaw/bin/openclaw
while true; do
  python3 "${ROOT}/scripts/neko/openclaw/approve.py" || true
  sleep 2
done
