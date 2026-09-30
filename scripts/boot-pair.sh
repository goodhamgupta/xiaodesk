#!/usr/bin/env bash
# Boot two overlay guests and put a headed page on each VGA desktop.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="${ROOT}/images"
BASE="${IMG}/guest-base.qcow2"
KEY="${IMG}/guest_ed25519"
OVERLAYS="${ROOT}/runs/overlays"
mkdir -p "${OVERLAYS}"

if [[ ! -f "${BASE}" || ! -f "${IMG}/guest-base.ready" ]]; then
  echo "build the guest image first: ./scripts/build-guest-image.sh" >&2
  exit 1
fi

ACCEL="$(tr -d '[:space:]' < "${IMG}/qemu-accel" || true)"
QEMU_ARGS=(-machine accel=tcg -cpu qemu64)
if [[ "${ACCEL}" == "kvm" ]]; then
  QEMU_ARGS=(-enable-kvm -cpu host)
fi

boot_one() {
  local name="$1" ssh_port="$2" vnc_port="$3"
  local overlay="${OVERLAYS}/${name}.qcow2"
  local pidfile="${IMG}/${name}.pid"
  local display="$((vnc_port - 5900))"
  if [[ -f "${pidfile}" ]] && kill -0 "$(cat "${pidfile}")" 2>/dev/null; then
    echo "${name} already running pid $(cat "${pidfile}")"
    return
  fi
  if [[ ! -f "${overlay}" ]]; then
    qemu-img create -f qcow2 -b "${BASE}" -F qcow2 "${overlay}"
  fi
  echo "booting ${name} vnc=${vnc_port} ssh=${ssh_port}"
  qemu-system-x86_64 \
    "${QEMU_ARGS[@]}" \
    -m 1536 -smp 2 \
    -vga std -device virtio-tablet-pci \
    -display none -vnc "127.0.0.1:${display},share=force-shared" \
    -monitor none -no-reboot \
    -drive "file=${overlay},if=virtio,format=qcow2,cache=writethrough" \
    -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${ssh_port}-:22" \
    -serial "file:${IMG}/${name}-serial.log" \
    > "${IMG}/${name}-qemu.log" 2>&1 &
  echo $! > "${pidfile}"
}

boot_one vm-1 24731 5931
boot_one vm-2 24732 5932

ssh_cmd() {
  local port="$1"
  shift
  ssh -i "${KEY}" -p "${port}" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o IdentitiesOnly=yes \
    -o ConnectTimeout=3 \
    -o BatchMode=yes \
    lume@127.0.0.1 "$@"
}

wait_ssh() {
  local name="$1" port="$2" pid
  pid="$(cat "${IMG}/${name}.pid")"
  for _ in $(seq 1 180); do
    if ssh_cmd "${port}" true >/dev/null 2>&1; then
      echo "${name} ssh up"
      return 0
    fi
    kill -0 "${pid}" 2>/dev/null || { echo "${name} qemu exited"; tail -n 30 "${IMG}/${name}-serial.log"; return 1; }
    sleep 2
  done
  echo "${name} ssh timed out"
  return 1
}

paint() {
  local name="$1" port="$2" color="$3"
  ssh_cmd "${port}" bash -s "${name}" "${color}" <<'EOF'
set -euo pipefail
name="$1"
color="#$2"
export DISPLAY=:0
ok=0
for _ in $(seq 1 40); do
  if xdpyinfo >/dev/null 2>&1; then ok=1; break; fi
  sleep 1
done
if [[ "${ok}" != 1 ]]; then
  echo "X not up on ${name}" >&2
  sudo journalctl -u workshop-display --no-pager -n 30 >&2 || true
  exit 1
fi
mkdir -p /tmp/screen
cat > /tmp/screen/index.html <<HTML
<!doctype html>
<meta charset="utf-8">
<title>${name}</title>
<body style="margin:0;background:${color};color:#fff;font-family:system-ui,sans-serif">
  <h1 style="margin:28px 28px 8px;font-size:42px">${name}</h1>
  <p style="margin:0 28px 12px;font-size:18px">Click the screen, then type. The field below is the guest, not the dashboard.</p>
  <button id="mark" style="margin:8px 28px;font-size:28px;padding:8px 16px" onclick="this.textContent='pointer hit'">Click target</button>
  <input id="q" autofocus style="display:block;margin:16px 28px;font-size:40px;width:80%;padding:8px">
</body>
HTML
if ! pgrep -f 'http.server 8765' >/dev/null 2>&1; then
  python3 -m http.server 8765 --directory /tmp/screen >/tmp/screen-http.log 2>&1 &
fi
CHROME=/opt/ms-playwright/chromium-1243/chrome-linux64/chrome
pkill -f chrome-linux64 >/dev/null 2>&1 || true
sleep 0.5
nohup "$CHROME" \
  --no-sandbox --disable-dev-shm-usage --disable-gpu \
  --ozone-platform=x11 --no-first-run --no-default-browser-check --disable-fre \
  --window-size=1280,800 --window-position=0,0 --start-maximized \
  --user-data-dir=/tmp/chrome-profile \
  http://127.0.0.1:8765/ \
  >/tmp/chrome-display.log 2>&1 &
for _ in $(seq 1 20); do
  id=$(xdotool search --class Chromium-browser 2>/dev/null | head -1 || true)
  if [[ -n "${id}" ]]; then
    xdotool windowmap "${id}" || true
    xdotool windowmove "${id}" 0 0 || true
    xdotool windowsize "${id}" 1280 800 || true
    xdotool windowactivate "${id}" || true
    break
  fi
  sleep 0.5
done
echo "painted ${name}"
EOF
}

wait_ssh vm-1 24731
wait_ssh vm-2 24732
paint vm-1 24731 '10243f'
paint vm-2 24732 '3b1d4a'
echo "pair ready"
