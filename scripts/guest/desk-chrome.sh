#!/bin/bash
# Right-click menu launcher. The desk chat uses scripts/guest/desk-act.mjs.
set -eu
bin=""
for candidate in /opt/ms-playwright/*/chrome-linux64/chrome; do
  if [[ -x "$candidate" ]]; then bin="$candidate"; break; fi
done
if [[ -z "$bin" ]]; then
  echo "chrome missing" >&2
  exit 1
fi
exec "$bin" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --ozone-platform=x11 \
  --no-first-run \
  --no-default-browser-check \
  --disable-fre \
  --class=deskchrome \
  --window-size=1280,800 \
  --window-position=0,0 \
  --user-data-dir "$HOME/.config/desk-chrome" \
  "${1:-about:blank}"
