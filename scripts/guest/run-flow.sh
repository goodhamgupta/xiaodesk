#!/bin/bash
# Run on the guest. Chrome first, then Calc. Status stays "running" until both finish.
set -u
echo running > /tmp/osworld-status
export OSWORLD_HOLD=1
node /tmp/solve-browser.mjs /tmp/browse.json > /tmp/osworld.log 2>&1 || { echo fail > /tmp/osworld-status; exit 1; }
if [[ -f /tmp/chrome.pid ]]; then
  pid="$(tr -d '[:space:]' < /tmp/chrome.pid)"
  kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
fi
python3 /tmp/solve_calc.py /tmp/calc.json >> /tmp/osworld.log 2>&1 || { echo fail > /tmp/osworld-status; exit 1; }
echo ok > /tmp/osworld-status
