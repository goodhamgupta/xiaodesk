#!/usr/bin/env bash
# Host OpenClaw gateway (loopback :18789) plus a node host inside each neko
# container. One gateway owns the main chat. VMs post to it; the dashboard
# dispatches desktop work back through the paired node.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${OPENCLAW_STATE_DIR:-${ROOT}/runs/openclaw/state}"
CONFIG="${OPENCLAW_CONFIG_PATH:-${ROOT}/runs/openclaw/openclaw.json}"
RUN="${ROOT}/runs/openclaw"
CLAW="${OPENCLAW_BIN:-/opt/openclaw/bin/openclaw}"
container="${NEKO_NAME:-workshop-neko}"
gateway_only=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --container) container="$2"; shift 2 ;;
    --gateway-only) gateway_only=1; shift ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done

if [[ ! -x "$CLAW" ]]; then
  echo "openclaw missing at $CLAW. Install with: bash /tmp/openclaw-install.sh --prefix /opt/openclaw --no-onboard" >&2
  exit 1
fi

mkdir -p "$RUN" "$STATE" "${RUN}/hooks/transforms"
if [[ ! -f "${RUN}/gateway.token" ]]; then
  umask 077
  openssl rand -hex 32 > "${RUN}/gateway.token"
fi
if [[ ! -f "${RUN}/hook.token" ]]; then
  umask 077
  openssl rand -hex 32 > "${RUN}/hook.token"
fi
chmod 600 "${RUN}/gateway.token" "${RUN}/hook.token"
cp "${ROOT}/scripts/neko/openclaw/transforms/desk-inbox.js" "${RUN}/hooks/transforms/desk-inbox.js"
python3 - "$CONFIG" "${RUN}/gateway.token" "${RUN}/hook.token" "${RUN}/hooks/transforms" "${ROOT}" <<'PY'
import json, sys
config, gw_path, hook_path, transforms, root = sys.argv[1:]
gw = open(gw_path).read().strip()
hook = open(hook_path).read().strip()
cfg = {
    "gateway": {
        "mode": "local",
        "bind": "loopback",
        "port": 18789,
        "auth": {"mode": "token", "token": gw},
        "nodes": {
            "pairing": {
                "autoApproveLocal": True,
                "autoApproveCidrs": ["127.0.0.1/32", "::1/128"],
                "sshVerify": False,
            }
        },
    },
    "hooks": {
        "enabled": True,
        "token": hook,
        "path": "/hooks",
        "allowedAgentIds": ["main"],
        "transformsDir": transforms,
        "mappings": [{
            "id": "desk-inbox",
            "match": {"path": "desk"},
            "action": "wake",
            "transform": {"module": "desk-inbox.js", "export": "transform"},
        }],
    },
    "tools": {"profile": "coding", "exec": {"host": "node", "security": "full", "ask": "off"}},
    "agents": {"defaults": {"workspace": root}},
}
open(config, "w").write(json.dumps(cfg, indent=2) + "\n")
PY

export PATH="$(dirname "$CLAW"):$PATH"
export OPENCLAW_STATE_DIR="$STATE"
export OPENCLAW_CONFIG_PATH="$CONFIG"
export OPENCLAW_DESK_INBOX="${RUN}/inbox.jsonl"
chmod 755 "${ROOT}/scripts/openclaw-gateway-run.sh" "${ROOT}/scripts/openclaw-approve-run.sh"

tmux_bin() { tmux -f /exec-daemon/tmux.portal.conf "$@"; }

if ! curl -sf -o /dev/null --max-time 1 http://127.0.0.1:18789/readyz; then
  if tmux_bin has-session -t openclaw-gateway 2>/dev/null; then
    tmux_bin kill-session -t openclaw-gateway
  fi
  tmux_bin new-session -d -s openclaw-gateway -c "$ROOT" -- bash -lc "exec ${ROOT}/scripts/openclaw-gateway-run.sh >>/tmp/openclaw-gateway.log 2>&1"
fi

# Command-surface approval is separate from device auto-approve. Loopback
# nodes still show up in `nodes pending` until this accepts system.run.
if ! tmux_bin has-session -t openclaw-approve 2>/dev/null; then
  tmux_bin new-session -d -s openclaw-approve -c "$ROOT" -- bash -lc "exec ${ROOT}/scripts/openclaw-approve-run.sh >>/tmp/openclaw-approve.log 2>&1"
fi

if [[ "$gateway_only" == "1" ]]; then
  echo "openclaw gateway http://127.0.0.1:18789"
  exit 0
fi

docker_cmd() {
  if docker info >/dev/null 2>&1; then docker "$@"; else sudo -n docker "$@"; fi
}
if docker_cmd ps -a --format '{{.Names}}' | grep -qx "$container"; then
  docker_cmd cp "${ROOT}/scripts/neko/desk-act.py" "${container}:/tmp/desk-act.py" >/dev/null
  docker_cmd cp "${ROOT}/scripts/neko/desk-mcp.py" "${container}:/tmp/desk-mcp.py" >/dev/null
  docker_cmd cp "${ROOT}/scripts/neko/desk-tell.sh" "${container}:/home/neko/.local/bin/desk-tell" >/dev/null || {
    docker_cmd exec "$container" mkdir -p /home/neko/.local/bin
    docker_cmd cp "${ROOT}/scripts/neko/desk-tell.sh" "${container}:/home/neko/.local/bin/desk-tell" >/dev/null
  }
  docker_cmd exec "$container" chmod 755 /home/neko/.local/bin/desk-tell
  docker_cmd cp "${RUN}/gateway.token" "${container}:/tmp/openclaw-gateway.token" >/dev/null
  docker_cmd cp "${RUN}/hook.token" "${container}:/tmp/openclaw-hook.token" >/dev/null
  docker_cmd exec "$container" chown neko:neko /tmp/openclaw-gateway.token /tmp/openclaw-hook.token
  docker_cmd exec "$container" chmod 600 /tmp/openclaw-gateway.token /tmp/openclaw-hook.token
  docker_cmd cp "${ROOT}/scripts/neko/openclaw-node.sh" "${container}:/tmp/openclaw-node.sh" >/dev/null
  docker_cmd exec -d -e "OPENCLAW_NODE_NAME=${container}" -e "DISPLAY=${NEKO_DISPLAY:-:99.0}" "$container" bash /tmp/openclaw-node.sh
fi
echo "openclaw gateway http://127.0.0.1:18789  node=${container}"
