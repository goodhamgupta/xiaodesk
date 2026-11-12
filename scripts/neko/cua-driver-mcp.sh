#!/usr/bin/env bash
# stdio MCP server for Codex. The driver daemon lives in the neko desktop
# (DISPLAY=:99.0), so this wrapper execs `cua-driver mcp` inside that container.
set -euo pipefail
name="${NEKO_NAME:-workshop-neko}"
display="${NEKO_DISPLAY:-:99.0}"

if [[ -n "${DOCKER_BIN:-}" ]]; then
  exec "$DOCKER_BIN" exec -i \
    -u neko \
    -e DISPLAY="${display}" \
    -e HOME=/home/neko \
    -e XDG_RUNTIME_DIR=/tmp/runtime-neko \
    -e CUA_DRIVER_PERMISSION_MODE="${CUA_DRIVER_PERMISSION_MODE:-standard}" \
    "$name" \
    bash -lc 'exec "$HOME/.local/bin/cua-driver" mcp'
fi

if command -v podman >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; then
  exec podman exec -i \
    -u neko \
    -e DISPLAY="${display}" \
    -e HOME=/home/neko \
    -e XDG_RUNTIME_DIR=/tmp/runtime-neko \
    -e CUA_DRIVER_PERMISSION_MODE="${CUA_DRIVER_PERMISSION_MODE:-standard}" \
    "$name" \
    bash -lc 'exec "$HOME/.local/bin/cua-driver" mcp'
fi

exec docker exec -i \
  -u neko \
  -e DISPLAY="${display}" \
  -e HOME=/home/neko \
  -e XDG_RUNTIME_DIR=/tmp/runtime-neko \
  -e CUA_DRIVER_PERMISSION_MODE="${CUA_DRIVER_PERMISSION_MODE:-standard}" \
  "$name" \
  bash -lc 'exec "$HOME/.local/bin/cua-driver" mcp'
