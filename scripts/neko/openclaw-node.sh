#!/usr/bin/env bash
# Run inside a neko container. Connects this desktop to the host OpenClaw
# gateway as a node named after the container. Does not start a second gateway.
set -euo pipefail
name="${OPENCLAW_NODE_NAME:-${1:-workshop-neko}}"
display="${DISPLAY:-:99.0}"
claw="${OPENCLAW_BIN:-/opt/openclaw/bin/openclaw}"
if [[ ! -x "$claw" ]]; then
  echo "openclaw is not installed at $claw" >&2
  exit 1
fi
install -d -o neko -g neko /home/neko/.openclaw /home/neko/.local/bin /tmp/runtime-neko
chmod 700 /home/neko/.openclaw /tmp/runtime-neko
if [[ -f /workspace/scripts/neko/desk-act.py ]]; then
  cp /workspace/scripts/neko/desk-act.py /tmp/desk-act.py
fi
if [[ -f /workspace/scripts/neko/desk-mcp.py ]]; then
  cp /workspace/scripts/neko/desk-mcp.py /tmp/desk-mcp.py
fi
if [[ -f /workspace/scripts/neko/desk-tell.sh ]]; then
  cp /workspace/scripts/neko/desk-tell.sh /home/neko/.local/bin/desk-tell
  chmod 755 /home/neko/.local/bin/desk-tell
fi
token=""
if [[ -n "${OPENCLAW_GATEWAY_TOKEN:-}" ]]; then
  token="$OPENCLAW_GATEWAY_TOKEN"
elif [[ -f /workspace/runs/openclaw/gateway.token ]]; then
  token="$(cat /workspace/runs/openclaw/gateway.token)"
elif [[ -f /tmp/openclaw-gateway.token ]]; then
  token="$(cat /tmp/openclaw-gateway.token)"
fi
if [[ -z "$token" ]]; then
  echo "gateway token missing. Run scripts/openclaw-up.sh on the host first." >&2
  exit 1
fi
gateway_url="${OPENCLAW_GATEWAY_URL:-ws://127.0.0.1:18789}"
gateway_hostport="${gateway_url#ws://}"
gateway_hostport="${gateway_hostport%%/*}"
if [[ -f /workspace/runs/openclaw/hook.token ]]; then
  install -o neko -g neko -m 600 /workspace/runs/openclaw/hook.token /home/neko/.openclaw/hook.token
elif [[ -f /tmp/openclaw-hook.token ]]; then
  install -o neko -g neko -m 600 /tmp/openclaw-hook.token /home/neko/.openclaw/hook.token
fi
python3 - "$token" "$gateway_url" <<'PY'
import json, sys
token = sys.argv[1].strip()
gateway_url = sys.argv[2].strip()
cfg = {
    "gateway": {
        "mode": "remote",
        "remote": {"url": gateway_url, "token": token},
    },
    "nodeHost": {
        "mcp": {
            "servers": {
                "desk": {
                    "command": "python3",
                    "args": ["/tmp/desk-mcp.py"],
                    "env": {
                        "DISPLAY": __import__("os").environ.get("DISPLAY", ":99.0"),
                        "HOME": "/home/neko",
                        "XDG_RUNTIME_DIR": "/tmp/runtime-neko",
                    },
                }
            }
        }
    },
}
open("/home/neko/.openclaw/openclaw.json", "w").write(json.dumps(cfg, indent=2) + "\n")
PY
chown neko:neko /home/neko/.openclaw/openclaw.json
chmod 600 /home/neko/.openclaw/openclaw.json
if [[ -f /tmp/desk-act.py ]]; then chown neko:neko /tmp/desk-act.py /tmp/desk-mcp.py 2>/dev/null || true; fi
# Replace a previous node host so the MCP server list is the one just written.
ps -u neko -o pid=,args= | awk '/entry.js node run/ {print $1}' | while read -r pid; do
  kill "$pid" 2>/dev/null || true
done
sleep 0.4
echo "openclaw node ${name} -> ${gateway_url}"
exec su -s /bin/bash neko -c "export HOME=/home/neko DISPLAY=${display} XDG_RUNTIME_DIR=/tmp/runtime-neko OPENCLAW_STATE_DIR=/home/neko/.openclaw OPENCLAW_CONFIG_PATH=/home/neko/.openclaw/openclaw.json OPENCLAW_NODE_NAME=${name} OPENCLAW_GATEWAY_URL=${gateway_url}; mkdir -p \"\$XDG_RUNTIME_DIR\"; exec ${claw} node run --host ${gateway_hostport%:*} --port ${gateway_hostport##*:} --display-name ${name} --no-tls >>/tmp/openclaw-node.log 2>&1"
