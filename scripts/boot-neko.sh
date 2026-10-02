#!/usr/bin/env bash
# Xfce desktop in Docker, streamed by neko. Host network: this machine's
# dockerd runs with iptables off, so published ports never NAT.
set -euo pipefail
name="${NEKO_NAME:-workshop-neko}"
image="${NEKO_IMAGE:-ghcr.io/m1k1o/neko/xfce:latest}"
bind="${NEKO_BIND:-127.0.0.1:8341}"

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
  docker_cmd run -d \
    --name "$name" \
    --network host \
    --shm-size 2g \
    -e "NEKO_SERVER_BIND=${bind}" \
    -e NEKO_DESKTOP_SCREEN=1280x800@30 \
    -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=neko \
    -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=admin \
    -e NEKO_WEBRTC_EPR=52000-52100 \
    -e NEKO_WEBRTC_ICELITE=true \
    -e NEKO_WEBRTC_NAT1TO1=127.0.0.1 \
    -e NEKO_WEBRTC_ICECANDIDATEIP=127.0.0.1 \
    "$image" >/dev/null
fi

echo "neko ${name} -> http://${bind}  user/neko  admin/admin"
