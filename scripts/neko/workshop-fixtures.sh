#!/usr/bin/env bash
# Open the fixture apps in the container's Firefox.
set -euo pipefail
export DISPLAY="${DISPLAY:-:99.0}"
url="${WORKSHOP_FIXTURES_URL:-http://127.0.0.1:4317}"
target="${1:-/}"
firefox=/usr/lib/firefox-esr/firefox-esr
if [[ ! -x "$firefox" ]]; then
  firefox="$(command -v firefox-esr || command -v firefox || true)"
fi
if [[ -z "$firefox" ]]; then
  echo "no Firefox binary found" >&2
  exit 1
fi
# Stay detached: this is launched from a desktop entry and from podman exec.
setsid "$firefox" --new-window "${url%/}${target}" \
  >/tmp/firefox-workshop.log 2>&1 < /dev/null &
exit 0
