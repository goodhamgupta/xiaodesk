#!/usr/bin/env bash
# Open the fixture index and each app inside the neko desktop, then capture
# the screen for each one. The container's WORKSHOP_FIXTURES_URL points at the
# host fixture server (host.docker.internal on macOS, 127.0.0.1 on Linux).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
container="${NEKO_NAME:-workshop-neko}"
if [[ -n "${DOCKER_BIN:-}" ]]; then
  bin="$DOCKER_BIN"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  bin=docker
elif command -v podman >/dev/null 2>&1; then
  bin=podman
else
  echo "neither docker nor podman is available" >&2
  exit 1
fi

exec_in() {
  $bin exec -u neko \
    -e DISPLAY=:99.0 \
    -e HOME=/home/neko \
    -e XDG_RUNTIME_DIR=/tmp/runtime-neko \
    "$container" "$@"
}

mkdir -p "${ROOT}/runs/shots"
# Avoid Firefox's profile lock dialog when earlier demo windows are still open.
exec_in pkill -f 'firefox-esr' >/dev/null 2>&1 || true
sleep 1
for app in "" onboarding support booking; do
  label="${app:-index}"
  exec_in /usr/local/bin/workshop-fixtures "/${app}" >/dev/null 2>&1 || true
  sleep 3
  exec_in scrot -o "/tmp/workshop-${label}.png"
  $bin cp "${container}:/tmp/workshop-${label}.png" "${ROOT}/runs/shots/workshop-${label}.png" >/dev/null
  echo "runs/shots/workshop-${label}.png"
done
