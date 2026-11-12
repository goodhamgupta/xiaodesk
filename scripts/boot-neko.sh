#!/usr/bin/env bash
# Xfce desktops in containers, streamed by neko and VNC.
#
# Linux: host networking. macOS: published HTTP/VNC/WebRTC ports. By default
# this starts two desks so the wall always has at least two live VMs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
primary_name="${NEKO_NAME:-workshop-neko}"
secondary_name="${NEKO_SECONDARY_NAME:-${primary_name}-2}"
primary_port="${NEKO_PORT:-8341}"
primary_vnc="${NEKO_VNC_PORT:-5930}"
secondary_port="${NEKO_SECONDARY_PORT:-8342}"
secondary_vnc="${NEKO_SECONDARY_VNC_PORT:-5931}"
os="$(uname -s)"

if [[ "$os" == "Linux" ]]; then
  fixtures_url="${WORKSHOP_FIXTURES_URL:-http://127.0.0.1:4317}"
else
  fixtures_url="${WORKSHOP_FIXTURES_URL:-http://host.docker.internal:4317}"
fi

if [[ -n "${DOCKER_BIN:-}" ]]; then
  container_bin="$DOCKER_BIN"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  container_bin=docker
elif command -v podman >/dev/null 2>&1; then
  container_bin=podman
elif command -v docker >/dev/null 2>&1; then
  container_bin="sudo -n docker"
else
  echo "neither docker nor podman is available" >&2
  exit 1
fi

container() { $container_bin "$@"; }

if [[ "$os" == "Linux" ]]; then
  if [[ -S /var/run/docker.sock ]]; then
    chmod 666 /var/run/docker.sock 2>/dev/null || sudo -n chmod 666 /var/run/docker.sock || true
  fi
fi

nat_ip() {
  if [[ -n "${NEKO_NAT_IP:-}" ]]; then echo "$NEKO_NAT_IP"; return; fi
  if [[ "$os" == "Linux" ]]; then
    ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}'
  fi
}

start_desk() {
  local name="$1" port="$2" vnc="$3" udp="$4" tcp="$5" epr="$6" fixtures_app="${7:-/}"
  local image="${NEKO_IMAGE:-workshop-neko:desk}"
  local network=() server_bind="" nat=""
  nat="$(nat_ip)"; nat="${nat:-127.0.0.1}"
  if [[ "$os" == "Linux" ]]; then
    network=(--network host)
    server_bind="${NEKO_BIND:-127.0.0.1:${port}}"
  else
    network=(
      -p "127.0.0.1:${port}:${port}"
      -p "127.0.0.1:${vnc}:${vnc}"
      -p "0.0.0.0:${udp}-$((udp + 8)):$((udp))-$((udp + 8))/udp"
      -p "0.0.0.0:${tcp}:${tcp}/tcp"
    )
    server_bind="0.0.0.0:${port}"
  fi

  if container ps -a --format '{{.Names}}' | grep -qx "$name"; then
    container start "$name" >/dev/null
  else
    openclaw_args=()
    if [[ -x /opt/openclaw/bin/openclaw ]]; then
      openclaw_args=(-v /opt/openclaw:/opt/openclaw:ro -e "OPENCLAW_NODE_NAME=${name}")
    fi
    container run -d \
      --name "$name" \
      "${network[@]}" \
      --shm-size 2g \
      "${openclaw_args[@]}" \
      -e "NEKO_SERVER_BIND=${server_bind}" \
      -e "NEKO_SERVER_PATH_PREFIX=/neko/${name}" \
      -e "WORKSHOP_FIXTURES_URL=${fixtures_url}" \
      -e "NEKO_VNC_PORT=${vnc}" \
      -e "NEKO_WEBRTC_EPR=${epr}" \
      -e "NEKO_WEBRTC_UDPMUX=${udp}" \
      -e "NEKO_WEBRTC_TCPMUX=${tcp}" \
      -e "NEKO_WEBRTC_ICELITE=true" \
      -e "NEKO_WEBRTC_ICETRICKLE=false" \
      -e "NEKO_WEBRTC_NAT1TO1=${nat}" \
      -e 'NEKO_WEBRTC_ICESERVERS_FRONTEND=[]' \
      -e 'NEKO_WEBRTC_ICESERVERS_BACKEND=[]' \
      -e NEKO_SESSION_COOKIE_SECURE=false \
      -e NEKO_IMPLICIT_CONTROL=true \
      -e NEKO_CONTROL_PROTECTION=false \
      -e NEKO_DESKTOP_SCREEN=1280x800@30 \
      -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=neko \
      -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=admin \
      -e CUA_DRIVER_PERMISSION_MODE="${CUA_DRIVER_PERMISSION_MODE:-unrestricted}" \
      "$image" >/dev/null
  fi

  for _ in $(seq 1 90); do
    if curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:${port}/neko/${name}/" 2>/dev/null; then break; fi
    sleep 1
  done

  DOCKER_BIN="$container_bin" NEKO_NAME="$name" bash "${ROOT}/scripts/neko/install-ui.sh"

  if [[ "${WORKSHOP_OPEN_FIXTURES:-1}" == "1" ]]; then
    $container_bin exec -u neko \
      -e DISPLAY=:99.0 -e HOME=/home/neko -e XDG_RUNTIME_DIR=/tmp/runtime-neko \
      "$name" /usr/local/bin/workshop-fixtures "$fixtures_app" >/dev/null 2>&1 || true
  fi

  if [[ -x /opt/openclaw/bin/openclaw ]]; then
    bash "${ROOT}/scripts/openclaw-up.sh" --container "$name"
  fi
  echo "neko ${name} -> http://127.0.0.1:${port}/neko/${name}/  vnc=127.0.0.1:${vnc}  user/neko  admin/admin"
}

start_desk "$primary_name" "$primary_port" "$primary_vnc" \
  "${NEKO_WEBRTC_UDPMUX:-52100}" "${NEKO_WEBRTC_TCPMUX:-52151}" "${NEKO_WEBRTC_EPR:-52100-52108}" \
  "${WORKSHOP_FIXTURES_APP:-/}"

if [[ "${NEKO_SECONDARY:-1}" == "1" ]]; then
  start_desk "$secondary_name" "$secondary_port" "$secondary_vnc" \
    "${NEKO_SECONDARY_UDPMUX:-52300}" "${NEKO_SECONDARY_TCPMUX:-52351}" "${NEKO_SECONDARY_EPR:-52300-52308}" \
    "${WORKSHOP_SECONDARY_FIXTURES_APP:-/support}"
fi
