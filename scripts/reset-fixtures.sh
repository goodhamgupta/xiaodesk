#!/usr/bin/env bash
set -euo pipefail
PORT="${FIXTURES_PORT:-4317}"
curl -sf -X POST "http://127.0.0.1:${PORT}/api/reset"
echo
