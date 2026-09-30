#!/usr/bin/env bash
# Boot the baked guest image and install the VGA desktop. Safe to re-run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="${ROOT}/images"
GUEST="${IMG}/guest-base.qcow2"
KEY="${IMG}/guest_ed25519"
SSH_PORT="${SSH_PORT:-24731}"
VNC_PORT="${VNC_PORT:-5931}"
READY="${IMG}/guest-display.ready"

if [[ ! -f "${GUEST}" || ! -f "${IMG}/guest-base.ready" ]]; then
  echo "build the guest image first: ./scripts/build-guest-image.sh" >&2
  exit 1
fi
if [[ -f "${READY}" ]]; then
  echo "guest display already installed"
  exit 0
fi

VNC_DISPLAY="$((VNC_PORT - 5900))"
ACCEL="$(tr -d '[:space:]' < "${IMG}/qemu-accel" || true)"
QEMU_ARGS=(-machine accel=tcg -cpu qemu64)
if [[ "${ACCEL}" == "kvm" ]]; then
  QEMU_ARGS=(-enable-kvm -cpu host)
fi

echo "booting guest to install the VGA desktop (vnc ${VNC_PORT})"
qemu-system-x86_64 \
  "${QEMU_ARGS[@]}" \
  -m 1536 -smp 2 \
  -vga std -device virtio-tablet-pci -display none -vnc "127.0.0.1:${VNC_DISPLAY},share=force-shared" \
  -monitor none -no-reboot \
  -drive "file=${GUEST},if=virtio,format=qcow2,cache=writethrough" \
  -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22" \
  -serial "file:${IMG}/display-serial.log" \
  > "${IMG}/display-qemu.log" 2>&1 &
QEMU_PID=$!
cleanup() {
  if kill -0 "${QEMU_PID}" 2>/dev/null; then
    kill "${QEMU_PID}" 2>/dev/null || true
    wait "${QEMU_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

SSH=(ssh -i "${KEY}" -p "${SSH_PORT}"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o IdentitiesOnly=yes
  -o ConnectTimeout=3
  -o BatchMode=yes
  lume@127.0.0.1)

ready=0
for _ in $(seq 1 180); do
  if "${SSH[@]}" true >/dev/null 2>&1; then
    ready=1
    break
  fi
  kill -0 "${QEMU_PID}" 2>/dev/null || { echo "qemu exited"; tail -n 40 "${IMG}/display-serial.log"; exit 1; }
  sleep 2
done
[[ "${ready}" == 1 ]] || { echo "ssh timed out"; exit 1; }

"${SSH[@]}" 'sudo cloud-init status --wait' >/dev/null 2>&1 || true
echo "installing X"
"${SSH[@]}" 'bash -s' < "${ROOT}/scripts/guest-display.sh"
echo "powering off"
"${SSH[@]}" 'sudo poweroff' >/dev/null 2>&1 || true
for _ in $(seq 1 90); do
  kill -0 "${QEMU_PID}" 2>/dev/null || break
  sleep 1
done
wait "${QEMU_PID}" 2>/dev/null || true
trap - EXIT
date -u +%Y-%m-%dT%H:%M:%SZ > "${READY}"
echo "guest display installed"
