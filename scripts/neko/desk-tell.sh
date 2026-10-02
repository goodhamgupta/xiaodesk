#!/usr/bin/env bash
# Post one line from this VM into the main desk chat. The OpenClaw gateway
# accepts it on /hooks/desk and the dashboard reads the inbox the hook writes.
set -euo pipefail
text="${1:-}"
if [[ -z "$text" ]]; then
  echo "usage: desk-tell <message>" >&2
  exit 2
fi
from="${OPENCLAW_NODE_NAME:-workshop-neko}"
token_file="${OPENCLAW_HOOK_TOKEN_FILE:-}"
if [[ -z "$token_file" ]]; then
  if [[ -f /home/neko/.openclaw/hook.token ]]; then
    token_file=/home/neko/.openclaw/hook.token
  else
    token_file=/workspace/runs/openclaw/hook.token
  fi
fi
if [[ ! -f "$token_file" ]]; then
  echo "openclaw hook token is missing ($token_file). Start the gateway with scripts/openclaw-up.sh." >&2
  exit 1
fi
python3 - "$from" "$text" "$(cat "$token_file")" <<'PY'
import json, sys, urllib.request
from_name, text, token = sys.argv[1], sys.argv[2], sys.argv[3].strip()
body = json.dumps({"from": from_name, "text": text}).encode()
req = urllib.request.Request(
    "http://127.0.0.1:18789/hooks/desk",
    data=body,
    headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=10) as res:
    if res.status not in (200, 204):
        raise SystemExit(f"hook failed: HTTP {res.status}")
print("sent")
PY
