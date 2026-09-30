#!/usr/bin/env bash
# Boot as many TCG guests as this host can hold and run one OSWorld Calc task on each VGA desktop.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="${ROOT}/images"
BASE="${IMG}/guest-base.qcow2"
KEY="${IMG}/guest_ed25519"
OVERLAYS="${ROOT}/runs/overlays"
mkdir -p "${OVERLAYS}" "${ROOT}/runs/artifacts"
rm -f "${OVERLAYS}"/*.qcow2 "${IMG}"/*.dropped

if [[ ! -f "${BASE}" || ! -f "${IMG}/guest-base.ready" ]]; then
  echo "build the guest image first: ./scripts/build-guest-image.sh" >&2
  exit 1
fi

ACCEL="$(tr -d '[:space:]' < "${IMG}/qemu-accel" || true)"
QEMU_ARGS=(-machine accel=tcg -cpu qemu64)
if [[ "${ACCEL}" == "kvm" ]]; then
  QEMU_ARGS=(-enable-kvm -cpu host)
fi

MEM_MB="${GUEST_MEM_MB:-1024}"
TASKS=(
  calc-revenue
  calc-profit
  calc-overtime
  calc-invoice
  calc-reorder
  calc-grades
  calc-budget
  calc-shipping
)

avail_kb="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
# Steady RSS on this TCG host is about 1.45x the -m cap once the guest has touched its pages.
pred_kb=$(( MEM_MB * 1024 * 145 / 100 ))
reserve_kb=$(( 1100 * 1024 ))
fit=$(( (avail_kb - reserve_kb) / pred_kb ))
(( fit < 1 )) && fit=1
(( fit > ${#TASKS[@]} )) && fit=${#TASKS[@]}
echo "mem_available_kb=${avail_kb} predicted_rss_kb=${pred_kb} guests=${fit} memory_mb=${MEM_MB} smp=1 accel=${ACCEL:-tcg}"

CHOSEN=("${TASKS[@]:0:${fit}}")
DISPLAYS=()

boot_one() {
  local index="$1" name="$2"
  local ssh_port=$((24841 + index))
  local vnc_port=$((5941 + index))
  local overlay="${OVERLAYS}/${name}.qcow2"
  local pidfile="${IMG}/${name}.pid"
  local display="$((vnc_port - 5900))"
  if [[ -f "${pidfile}" ]] && kill -0 "$(cat "${pidfile}")" 2>/dev/null; then
    echo "${name} already running pid $(cat "${pidfile}")"
  else
    rm -f "${overlay}"
    qemu-img create -f qcow2 -b "${BASE}" -F qcow2 "${overlay}" >/dev/null
    echo "booting ${name} vnc=${vnc_port} ssh=${ssh_port} mem=${MEM_MB}"
    setsid qemu-system-x86_64 \
      "${QEMU_ARGS[@]}" \
      -m "${MEM_MB}" -smp 1 \
      -vga std -device virtio-tablet-pci \
      -display none -vnc "127.0.0.1:${display},share=force-shared" \
      -monitor none -no-reboot \
      -drive "file=${overlay},if=virtio,format=qcow2,cache=writethrough" \
      -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${ssh_port}-:22" \
      -serial "file:${IMG}/${name}-serial.log" \
      > "${IMG}/${name}-qemu.log" 2>&1 < /dev/null &
    echo $! > "${pidfile}"
    disown "$!" 2>/dev/null || true
  fi
  local title
  title="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"].replace(",", ""))' "${ROOT}/tasks/osworld/${name}.json")"
  DISPLAYS+=("${name}@${vnc_port}@${title}")
}

for index in "${!CHOSEN[@]}"; do
  boot_one "${index}" "${CHOSEN[$index]}"
done

IFS=','
echo "VNC_DISPLAYS=${DISPLAYS[*]}" | tee "${ROOT}/runs/osworld-displays.env"
IFS=$' \t\n'

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
    if ! kill -0 "${pid}" 2>/dev/null; then
      echo "${name} qemu exited" >&2
      tail -n 20 "${IMG}/${name}-serial.log" >&2 || true
      return 1
    fi
    sleep 2
  done
  echo "${name} ssh timed out" >&2
  return 1
}

trim_if_low_mem() {
  local avail pid name
  avail="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
  if (( avail >= 700 * 1024 )); then
    return
  fi
  name="${CHOSEN[$(( ${#CHOSEN[@]} - 1 ))]}"
  if [[ -f "${IMG}/${name}.dropped" ]]; then
    return
  fi
  pid="$(cat "${IMG}/${name}.pid" 2>/dev/null || true)"
  echo "MemAvailable=${avail}kB, stopping ${name} to stay clear of OOM"
  if [[ -n "${pid}" ]]; then kill -TERM "${pid}" || true; fi
  echo dropped > "${IMG}/${name}.dropped"
}

start_solver() {
  local index="$1" name="$2"
  local ssh_port=$((24841 + index))
  local task_json="/tmp/${name}.task.json"
  python3 - "${ROOT}/tasks/osworld/${name}.json" "${task_json}" <<'PY'
import json, sys
task = json.load(open(sys.argv[1]))
task["upload_url"] = f"http://10.0.2.2:4317/api/artifacts/{task['id']}"
json.dump(task, open(sys.argv[2], "w"))
PY
  scp -i "${KEY}" -P "${ssh_port}" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    "${ROOT}/scripts/guest/solve_calc.py" "lume@127.0.0.1:/tmp/solve_calc.py"
  scp -i "${KEY}" -P "${ssh_port}" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    "${task_json}" "lume@127.0.0.1:/tmp/task.json"
  ssh -i "${KEY}" -p "${ssh_port}" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    -o BatchMode=yes -f \
    lume@127.0.0.1 \
    "bash -lc 'python3 /tmp/solve_calc.py /tmp/task.json > /tmp/osworld.log 2>&1'"
  echo "solver started ${name}"
}

alive=()
for index in "${!CHOSEN[@]}"; do
  trim_if_low_mem
  name="${CHOSEN[$index]:-}"
  [[ -z "${name}" ]] && break
  if [[ -f "${IMG}/${name}.dropped" ]]; then
    echo "skip ${name}"
    continue
  fi
  if wait_ssh "${name}" "$((24841 + index))"; then
    alive+=("${index}:${name}")
    start_solver "${index}" "${name}"
  fi
done

if ((${#alive[@]})); then
  echo "solvers launched: ${alive[*]}"
else
  echo "solvers launched: none"
fi
deadline=$((SECONDS + 1500))
pending=()
if ((${#alive[@]})); then
  pending=("${alive[@]}")
fi
while (( SECONDS < deadline )) && (( ${#pending[@]} > 0 )); do
  trim_if_low_mem
  next=()
  for item in "${pending[@]}"; do
    index="${item%%:*}"
    name="${item#*:}"
    state="$(ssh_cmd "$((24841 + index))" "cat /tmp/osworld-status 2>/dev/null || true" 2>/dev/null || true)"
    state="${state//$'\r'/}"
    if [[ "${state}" == "ok" ]]; then
      echo "${name} ok"
    elif [[ "${state}" == "fail" ]]; then
      echo "${name} fail"
      ssh_cmd "$((24841 + index))" "tail -n 40 /tmp/osworld.log" || true
    else
      next+=("${item}")
    fi
  done
  pending=()
  if (( ${#next[@]} > 0 )); then
    pending=("${next[@]}")
  fi
  if (( ${#pending[@]} > 0 )); then
    echo "waiting ${pending[*]}"
    sleep 15
  fi
done

if (( ${#pending[@]} > 0 )); then
  echo "timed out: ${pending[*]}" >&2
  for item in "${pending[@]}"; do
    index="${item%%:*}"
    name="${item#*:}"
    echo "----- ${name} -----"
    ssh_cmd "$((24841 + index))" "tail -n 50 /tmp/osworld.log /tmp/soffice.log" || true
  done
fi

printf '%s\n' "${CHOSEN[@]}" > "${ROOT}/runs/osworld-guests.txt"
echo "wall ready"
