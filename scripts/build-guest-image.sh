#!/usr/bin/env bash
# Bake images/guest-base.qcow2: Debian 12 cloud + user lume + Node 22 + Playwright Chromium deps.
# Job VMs are qcow2 overlays on this image. Safe to re-run; skips when guest-base.ready exists.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="${ROOT}/images"
BASE="${IMG}/debian-12-genericcloud-amd64.qcow2"
GUEST="${IMG}/guest-base.qcow2"
NODE_VER="v22.14.0"
NODE_TAR="${IMG}/node-${NODE_VER}-linux-x64.tar.xz"
KEY="${IMG}/guest_ed25519"
SSH_PORT="${SSH_PORT:-24722}"
READY="${IMG}/guest-base.ready"
PLAYWRIGHT_CACHE="${PLAYWRIGHT_BROWSERS_PATH:-${HOME}/.cache/ms-playwright}"

mkdir -p "${IMG}"

if [[ -f "${READY}" && -f "${GUEST}" ]]; then
  echo "guest image already built: ${GUEST}"
  exit 0
fi

if [[ ! -f "${BASE}" ]]; then
  echo "downloading Debian 12 generic cloud image"
  curl -fL --retry 3 -o "${BASE}.partial" \
    https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2
  mv "${BASE}.partial" "${BASE}"
fi

if [[ ! -f "${NODE_TAR}" ]]; then
  echo "downloading Node ${NODE_VER}"
  curl -fL --retry 3 -o "${NODE_TAR}.partial" \
    "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz"
  mv "${NODE_TAR}.partial" "${NODE_TAR}"
fi

if [[ ! -d "${PLAYWRIGHT_CACHE}/chromium-1243" ]]; then
  echo "playwright chromium cache missing at ${PLAYWRIGHT_CACHE}" >&2
  echo "run: pnpm --filter guest-agent exec playwright install chromium" >&2
  exit 1
fi

detect_accel() {
  if [[ "${QEMU_ACCEL:-}" == "tcg" || "${QEMU_ACCEL:-}" == "kvm" ]]; then
    echo "${QEMU_ACCEL}"
    return
  fi
  if [[ ! -e /dev/kvm ]]; then
    echo tcg
    return
  fi
  local probe="${IMG}/accel-probe.qcow2"
  qemu-img create -f qcow2 -b "${GUEST}" -F qcow2 "${probe}" >/dev/null
  timeout 8 qemu-system-x86_64 -enable-kvm -cpu host -m 256 -smp 1 -nographic -no-reboot \
    -drive "file=${probe},if=virtio,format=qcow2" > "${IMG}/accel-probe.log" 2>&1 || true
  rm -f "${probe}"
  if grep -q SeaBIOS "${IMG}/accel-probe.log"; then
    echo kvm
  else
    echo "kvm did not reach SeaBIOS; using tcg" >&2
    echo tcg
  fi
}

if [[ ! -f "${KEY}" ]]; then
  ssh-keygen -t ed25519 -f "${KEY}" -N '' -C lume
fi
chmod 600 "${KEY}"

rm -f "${GUEST}" "${READY}"
cp "${BASE}" "${GUEST}"
qemu-img resize "${GUEST}" 12G

PUB="$(cat "${KEY}.pub")"
cat > "${IMG}/user-data" <<EOF
#cloud-config
users:
  - default
  - name: lume
    sudo: ALL=(ALL) NOPASSWD:ALL
    groups: sudo
    shell: /bin/bash
    ssh_authorized_keys:
      - ${PUB}
ssh_pwauth: false
package_update: false
EOF
printf 'instance-id: workshop-guest\nlocal-hostname: workshop-guest\n' > "${IMG}/meta-data"
cloud-localds "${IMG}/seed.img" "${IMG}/user-data" "${IMG}/meta-data"

SERIAL="${IMG}/build-serial.log"
rm -f "${SERIAL}"
ACCEL="$(detect_accel)"
printf '%s\n' "${ACCEL}" > "${IMG}/qemu-accel"
echo "booting installer VM on ssh port ${SSH_PORT} accel=${ACCEL}"
QEMU_ACCEL_ARGS=(-machine accel=tcg -cpu qemu64)
if [[ "${ACCEL}" == "kvm" ]]; then
  QEMU_ACCEL_ARGS=(-enable-kvm -cpu host)
fi
echo "packing workspace and playwright browsers"
tar -C "${ROOT}" -czf "${IMG}/workspace.tgz" \
  --exclude images --exclude runs --exclude .git --exclude apps/fixtures/data \
  bin packages/guest-agent packages/agents-api node_modules package.json pnpm-workspace.yaml
tar -C "${PLAYWRIGHT_CACHE}" -czf "${IMG}/playwright.tgz" .
cp "${NODE_TAR}" "${IMG}/node.tar.xz"

qemu-system-x86_64 \
  "${QEMU_ACCEL_ARGS[@]}" \
  -m 1536 \
  -smp 2 \
  -nographic \
  -no-reboot \
  -drive "file=${GUEST},if=virtio,format=qcow2" \
  -cdrom "${IMG}/seed.img" \
  -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${SSH_PORT}-:22" \
  > "${SERIAL}" 2>&1 &
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
  if ! kill -0 "${QEMU_PID}" 2>/dev/null; then
    echo "qemu exited before ssh came up. serial:" >&2
    tail -n 80 "${SERIAL}" >&2 || true
    exit 1
  fi
  sleep 2
done
if [[ "${ready}" != 1 ]]; then
  echo "ssh to the installer VM timed out. serial:" >&2
  tail -n 80 "${SERIAL}" >&2 || true
  exit 1
fi

echo "waiting for cloud-init to finish (it restarts ssh)"
cloud_ok=0
for _ in $(seq 1 90); do
  if "${SSH[@]}" 'sudo cloud-init status --wait' >/dev/null 2>&1; then
    cloud_ok=1
    break
  fi
  sleep 2
done
if [[ "${cloud_ok}" != 1 ]]; then
  echo "cloud-init did not finish. serial:" >&2
  tail -n 40 "${SERIAL}" >&2 || true
  exit 1
fi

echo "copying payloads into the guest"
SCP=(scp -i "${KEY}" -P "${SSH_PORT}"
  -o StrictHostKeyChecking=no
  -o UserKnownHostsFile=/dev/null
  -o IdentitiesOnly=yes
  -o BatchMode=yes
  -o ConnectTimeout=10)
copied=0
for _ in $(seq 1 5); do
  if "${SCP[@]}" "${IMG}/node.tar.xz" "${IMG}/workspace.tgz" "${IMG}/playwright.tgz" "lume@127.0.0.1:/tmp/"; then
    copied=1
    break
  fi
  echo "scp failed, retrying"
  sleep 3
done
if [[ "${copied}" != 1 ]]; then
  echo "scp into the guest failed" >&2
  exit 1
fi
echo "provisioning guest"
"${SSH[@]}" 'bash -s' < "${ROOT}/scripts/guest-provision.sh"

echo "powering off installer VM"
"${SSH[@]}" 'sudo poweroff' >/dev/null 2>&1 || true
for _ in $(seq 1 90); do
  if ! kill -0 "${QEMU_PID}" 2>/dev/null; then
    break
  fi
  sleep 1
done
if kill -0 "${QEMU_PID}" 2>/dev/null; then
  echo "qemu did not exit after poweroff" >&2
  exit 1
fi
wait "${QEMU_PID}" 2>/dev/null || true
trap - EXIT

date -u +%Y-%m-%dT%H:%M:%SZ > "${READY}"
echo "guest image ready: ${GUEST}"
