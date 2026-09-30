#!/usr/bin/env bash
# Boot the baked guest so its VGA framebuffer is on VNC, sync the headed
# browser sources onto the disk, and open Chromium on DISPLAY=:0.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="${ROOT}/images"
GUEST="${IMG}/guest-base.qcow2"
KEY="${IMG}/guest_ed25519"
SSH_PORT="${SSH_PORT:-24731}"
VNC_PORT="${VNC_PORT:-5931}"
VNC_DISPLAY="$((VNC_PORT - 5900))"
PIDFILE="${IMG}/preview-qemu.pid"
ACCEL="$(tr -d '[:space:]' < "${IMG}/qemu-accel" || true)"
QEMU_ARGS=(-machine accel=tcg -cpu qemu64)
if [[ "${ACCEL}" == "kvm" ]]; then
  QEMU_ARGS=(-enable-kvm -cpu host)
fi

if [[ -f "${PIDFILE}" ]] && kill -0 "$(cat "${PIDFILE}")" 2>/dev/null; then
  echo "preview qemu already running pid $(cat "${PIDFILE}")"
  exit 0
fi

echo "booting preview guest vnc=${VNC_PORT} ssh=${SSH_PORT} accel=${ACCEL:-tcg}"
qemu-system-x86_64 \
  "${QEMU_ARGS[@]}" \
  -m 1536 -smp 2 \
  -vga std -device virtio-tablet-pci -display none -vnc "127.0.0.1:${VNC_DISPLAY},share=force-shared" \
  -monitor none -no-reboot \
  -drive "file=${GUEST},if=virtio,format=qcow2,cache=writethrough" \
  -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22" \
  -serial "file:${IMG}/preview-serial.log" \
  > "${IMG}/preview-qemu.log" 2>&1 &
echo $! > "${PIDFILE}"
QEMU_PID="$(cat "${PIDFILE}")"
echo "qemu pid ${QEMU_PID}"

SSH=(ssh -i "${KEY}" -p "${SSH_PORT}"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o IdentitiesOnly=yes
  -o ConnectTimeout=3
  -o BatchMode=yes
  lume@127.0.0.1)
SCP=(scp -i "${KEY}" -P "${SSH_PORT}"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o IdentitiesOnly=yes
  -o ConnectTimeout=3
  -o BatchMode=yes)

ready=0
for _ in $(seq 1 180); do
  if "${SSH[@]}" true >/dev/null 2>&1; then
    ready=1
    break
  fi
  kill -0 "${QEMU_PID}" 2>/dev/null || { echo "qemu exited"; tail -n 30 "${IMG}/preview-serial.log"; exit 1; }
  sleep 2
done
[[ "${ready}" == 1 ]] || { echo "ssh timed out"; exit 1; }
echo "ssh up"

"${SCP[@]}" \
  "${ROOT}/packages/guest-agent/src/browser/browser-tool.ts" \
  "${ROOT}/packages/guest-agent/src/run-job.ts" \
  "${ROOT}/packages/guest-agent/src/exec-server.ts" \
  "${ROOT}/packages/guest-agent/src/worker.ts" \
  lume@127.0.0.1:/tmp/
"${SSH[@]}" 'cp /tmp/browser-tool.ts /workspace/packages/guest-agent/src/browser/browser-tool.ts && cp /tmp/run-job.ts /workspace/packages/guest-agent/src/run-job.ts && cp /tmp/exec-server.ts /workspace/packages/guest-agent/src/exec-server.ts && cp /tmp/worker.ts /workspace/packages/guest-agent/src/worker.ts && sync'
echo "guest sources synced"

ok=0
for _ in $(seq 1 40); do
  if "${SSH[@]}" 'DISPLAY=:0 xdpyinfo >/dev/null 2>&1'; then
    ok=1
    break
  fi
  sleep 1
done
[[ "${ok}" == 1 ]] || { echo "X not up"; "${SSH[@]}" 'sudo journalctl -u workshop-display --no-pager -n 40' || true; exit 1; }
echo "X is up"

"${SSH[@]}" 'bash -s' <<'EOF'
set -euo pipefail
export DISPLAY=:0
CHROME=/opt/ms-playwright/chromium-1243/chrome-linux64/chrome
if ! pgrep -f chrome-linux64 >/dev/null 2>&1; then
  nohup "$CHROME" \
    --no-sandbox --disable-dev-shm-usage --disable-gpu \
    --window-size=1280,800 --window-position=0,0 \
    http://10.0.2.2:4317/ \
    >/tmp/chrome-display.log 2>&1 &
fi
sleep 2
DISPLAY=:0 scrot -o /tmp/guest-screen.png || true
echo chrome_pid=$(pgrep -f chrome-linux64 | head -1 || true)
EOF

"${SCP[@]}" lume@127.0.0.1:/tmp/guest-screen.png "${IMG}/guest-screen.png" || true
echo "preview ready"
