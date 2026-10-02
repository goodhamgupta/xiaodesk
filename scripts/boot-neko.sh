#!/usr/bin/env bash
# Xfce desktop in Docker, streamed by neko. Host network: this machine's
# dockerd runs with iptables off, so published ports never NAT.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
name="${NEKO_NAME:-workshop-neko}"
image="${NEKO_IMAGE:-ghcr.io/m1k1o/neko/xfce:latest}"
bind="${NEKO_BIND:-127.0.0.1:8341}"
# pion rewrites every candidate to this address, so it must be an address
# that actually has the UDP mux socket. 127.0.0.1 is not one of those.
nat_ip="${NEKO_NAT_IP:-$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')}"
nat_ip="${nat_ip:-127.0.0.1}"

if [[ -S /var/run/docker.sock ]]; then
  chmod 666 /var/run/docker.sock 2>/dev/null || sudo -n chmod 666 /var/run/docker.sock || true
fi

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    sudo -n docker "$@"
  fi
}

if docker_cmd ps -a --format '{{.Names}}' | grep -qx "$name"; then
  docker_cmd start "$name" >/dev/null
else
  openclaw_args=()
  if [[ -x /opt/openclaw/bin/openclaw ]]; then
    openclaw_args=(-v /opt/openclaw:/opt/openclaw:ro -e "OPENCLAW_NODE_NAME=${name}")
  fi
  docker_cmd run -d \
    --name "$name" \
    --network host \
    --shm-size 2g \
    "${openclaw_args[@]}" \
    -e "NEKO_SERVER_BIND=${bind}" \
    -e NEKO_DESKTOP_SCREEN=1280x800@30 \
    -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=neko \
    -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=admin \
    -e NEKO_WEBRTC_EPR=52100-52200 \
    -e NEKO_WEBRTC_UDPMUX=52100 \
    -e NEKO_WEBRTC_TCPMUX=52151 \
    -e NEKO_WEBRTC_ICELITE=true \
    -e NEKO_WEBRTC_ICETRICKLE=false \
    -e "NEKO_WEBRTC_NAT1TO1=${nat_ip}" \
    -e 'NEKO_WEBRTC_ICESERVERS_FRONTEND=[]' \
    -e 'NEKO_WEBRTC_ICESERVERS_BACKEND=[]' \
    -e NEKO_SESSION_COOKIE_SECURE=false \
    "$image" >/dev/null
fi

# The published xfce image ships the panel launchers and no browser.
# setup-inside.sh installs firefox-esr; do that here too so a plain boot is usable.
if ! docker_cmd exec "$name" bash -lc 'command -v firefox-esr >/dev/null || command -v firefox >/dev/null'; then
  docker_cmd exec "$name" bash -lc 'export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y firefox-esr'
fi

# Only needed when candidates are rewritten to loopback. pion does not bind
# the UDP mux on lo, so those checks would get no answer.
if [[ "${nat_ip}" == "127.0.0.1" ]] && ! ss -uln | grep -q '127.0.0.1:52100'; then
  if ! pgrep -f 'scripts/neko/udp-mux-lo.py' >/dev/null 2>&1; then
    setsid python3 "${ROOT}/scripts/neko/udp-mux-lo.py" \
      > /tmp/neko-udp-mux.log 2>&1 < /dev/null &
    disown "$!" 2>/dev/null || true
  fi
fi

bash "${ROOT}/scripts/neko/install-ui.sh"
if [[ -x /opt/openclaw/bin/openclaw ]]; then
  bash "${ROOT}/scripts/openclaw-up.sh" --container "$name"
fi
echo "neko ${name} -> http://${bind}  user/neko  admin/admin"
