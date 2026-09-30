#!/usr/bin/env bash
# Boot a mixed OSWorld wall: Chrome daily tasks and LibreOffice Calc, plus a
# multi-app workflow when RAM is left. Each guest gets a QMP socket for savevm.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="${ROOT}/images"
BASE="${IMG}/guest-base.qcow2"
KEY="${IMG}/guest_ed25519"
OVERLAYS="${ROOT}/runs/overlays"
QMP_DIR="${ROOT}/runs/qmp"
mkdir -p "${OVERLAYS}" "${ROOT}/runs/artifacts" "${QMP_DIR}" "${ROOT}/runs/recordings"

if [[ ! -f "${BASE}" || ! -f "${IMG}/guest-base.ready" ]]; then
  echo "build the guest image first: ./scripts/build-guest-image.sh" >&2
  exit 1
fi

stop_known() {
  local pidfile pid
  shopt -s nullglob
  local files=("${IMG}"/calc-*.pid "${IMG}"/browse-*.pid "${IMG}"/flow-*.pid)
  shopt -u nullglob
  for pidfile in "${files[@]}"; do
    pid="$(tr -d '[:space:]' < "${pidfile}" || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      echo "stopping $(basename "${pidfile}" .pid) pid ${pid}"
      kill -TERM "${pid}" || true
    fi
  done
  sleep 3
  for pidfile in "${files[@]}"; do
    pid="$(tr -d '[:space:]' < "${pidfile}" || true)"
    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      kill -KILL "${pid}" || true
      sleep 1
    fi
    rm -f "${pidfile}"
  done
}

stop_known
rm -f "${OVERLAYS}"/*.qcow2 "${IMG}"/*.dropped "${QMP_DIR}"/*.sock

ACCEL="$(tr -d '[:space:]' < "${IMG}/qemu-accel" || true)"
QEMU_ARGS=(-machine accel=tcg -cpu qemu64)
if [[ "${ACCEL}" == "kvm" ]]; then
  QEMU_ARGS=(-enable-kvm -cpu host)
fi

mapfile -t PLAN < <(python3 - <<'PY'
import pathlib
avail = 0
for line in pathlib.Path("/proc/meminfo").read_text().splitlines():
    if line.startswith("MemAvailable:"):
        avail = int(line.split()[1])
reserve = 1100 * 1024
budget = avail - reserve
# name, kind, guest MB, host RSS ratio percent. Measured Calc guests land near 1.85x.
jobs = [
    ("browse-onboarding", "browser", 1280, 190),
    ("calc-revenue", "calc", 1024, 185),
    ("browse-support", "browser", 1280, 190),
    ("calc-profit", "calc", 1024, 185),
    ("browse-booking", "browser", 1280, 190),
    ("calc-grades", "calc", 1024, 185),
    ("flow-triage", "workflow", 1408, 190),
]
print(f"# mem_available_kb={avail} budget_kb={budget}", flush=True)
for name, kind, mem, ratio in jobs:
    pred = mem * 1024 * ratio // 100
    if budget < pred:
        print(f"# skip {name} needs {pred}kb budget {budget}kb")
        continue
    budget -= pred
    print(f"{name} {kind} {mem}")
PY
)

echo "plan:"
printf '  %s\n' "${PLAN[@]}"
CHOSEN=()
KINDS=()
MEMS=()
for line in "${PLAN[@]}"; do
  [[ "${line}" == \#* ]] && continue
  read -r name kind mem <<<"${line}"
  CHOSEN+=("${name}")
  KINDS+=("${kind}")
  MEMS+=("${mem}")
done
if ((${#CHOSEN[@]} == 0)); then
  echo "not enough free RAM to boot a guest" >&2
  exit 1
fi

DISPLAYS=()
CONTROL_LINES=()

boot_one() {
  local index="$1" name="$2" mem="$3"
  local ssh_port=$((24841 + index))
  local vnc_port=$((5941 + index))
  local overlay="${OVERLAYS}/${name}.qcow2"
  local pidfile="${IMG}/${name}.pid"
  local qmp="${QMP_DIR}/${name}.sock"
  local display="$((vnc_port - 5900))"
  rm -f "${overlay}" "${qmp}"
  qemu-img create -f qcow2 -b "${BASE}" -F qcow2 "${overlay}" >/dev/null
  echo "booting ${name} vnc=${vnc_port} ssh=${ssh_port} mem=${mem} qmp=${qmp}"
  setsid qemu-system-x86_64 \
    "${QEMU_ARGS[@]}" \
    -m "${mem}" -smp 1 \
    -vga std -device virtio-tablet-pci \
    -display none -vnc "127.0.0.1:${display},share=force-shared" \
    -monitor none \
    -qmp "unix:${qmp},server,nowait" \
    -no-reboot \
    -drive "file=${overlay},if=virtio,format=qcow2,cache=writethrough,id=disk0" \
    -nic "user,model=virtio-net-pci,hostfwd=tcp:127.0.0.1:${ssh_port}-:22" \
    -serial "file:${IMG}/${name}-serial.log" \
    > "${IMG}/${name}-qemu.log" 2>&1 < /dev/null &
  echo $! > "${pidfile}"
  disown "$!" 2>/dev/null || true
  local title
  title="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"].replace(",", ""))' "${ROOT}/tasks/osworld/${name}.json")"
  DISPLAYS+=("${name}@${vnc_port}@${title}")
  CONTROL_LINES+=("${name} ${vnc_port} ${qmp}")
}

for index in "${!CHOSEN[@]}"; do
  boot_one "${index}" "${CHOSEN[$index]}" "${MEMS[$index]}"
done

IFS=','
echo "VNC_DISPLAYS=${DISPLAYS[*]}" | tee "${ROOT}/runs/osworld-displays.env"
IFS=$' \t\n'

python3 - "${ROOT}/runs/vm-control.json" "${CONTROL_LINES[@]}" <<'PY'
import json, sys
path, *rows = sys.argv[1:]
control = {}
for row in rows:
    name, port, qmp = row.split(" ", 2)
    control[name] = {"qmp": qmp, "vncPort": int(port)}
json.dump(control, open(path, "w"), indent=2)
print("vm-control", path, list(control))
PY

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

stamp_task() {
  local src="$1" dest="$2"
  python3 - "${src}" "${dest}" <<'PY'
import json, sys
task = json.load(open(sys.argv[1]))
task["fixtures_url"] = "http://10.0.2.2:4317"
if task.get("kind") != "browser":
    task["upload_url"] = f"http://10.0.2.2:4317/api/artifacts/{task['id']}"
json.dump(task, open(sys.argv[2], "w"))
PY
}

scp_to() {
  local port="$1" src="$2" dest="$3"
  scp -i "${KEY}" -P "${port}" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    "${src}" "lume@127.0.0.1:${dest}"
}

start_solver() {
  local index="$1" name="$2" kind="$3"
  local ssh_port=$((24841 + index))
  local task_json="/tmp/${name}.task.json"
  if [[ "${kind}" == "browser" ]]; then
    stamp_task "${ROOT}/tasks/osworld/${name}.json" "${task_json}"
    scp_to "${ssh_port}" "${ROOT}/scripts/guest/solve-browser.mjs" "/tmp/solve-browser.mjs"
    scp_to "${ssh_port}" "${task_json}" "/tmp/task.json"
    ssh -i "${KEY}" -p "${ssh_port}" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
      -o BatchMode=yes -f \
      lume@127.0.0.1 \
      "bash -lc 'node /tmp/solve-browser.mjs /tmp/task.json > /tmp/osworld.log 2>&1'"
  elif [[ "${kind}" == "workflow" ]]; then
    local browser calc
    browser="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["browser_task"])' "${ROOT}/tasks/osworld/${name}.json")"
    calc="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["calc_task"])' "${ROOT}/tasks/osworld/${name}.json")"
    stamp_task "${ROOT}/tasks/osworld/${browser}.json" "/tmp/${browser}.task.json"
    stamp_task "${ROOT}/tasks/osworld/${calc}.json" "/tmp/${calc}.task.json"
    scp_to "${ssh_port}" "${ROOT}/scripts/guest/solve-browser.mjs" "/tmp/solve-browser.mjs"
    scp_to "${ssh_port}" "${ROOT}/scripts/guest/solve_calc.py" "/tmp/solve_calc.py"
    scp_to "${ssh_port}" "${ROOT}/scripts/guest/run-flow.sh" "/tmp/run-flow.sh"
    scp_to "${ssh_port}" "/tmp/${browser}.task.json" "/tmp/browse.json"
    scp_to "${ssh_port}" "/tmp/${calc}.task.json" "/tmp/calc.json"
    ssh -i "${KEY}" -p "${ssh_port}" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
      -o BatchMode=yes -f \
      lume@127.0.0.1 \
      "bash /tmp/run-flow.sh"
  else
    stamp_task "${ROOT}/tasks/osworld/${name}.json" "${task_json}"
    scp_to "${ssh_port}" "${ROOT}/scripts/guest/solve_calc.py" "/tmp/solve_calc.py"
    scp_to "${ssh_port}" "${task_json}" "/tmp/task.json"
    ssh -i "${KEY}" -p "${ssh_port}" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
      -o BatchMode=yes -f \
      lume@127.0.0.1 \
      "bash -lc 'python3 /tmp/solve_calc.py /tmp/task.json > /tmp/osworld.log 2>&1'"
  fi
  echo "solver started ${name} (${kind})"
}

if curl -sf -X POST http://127.0.0.1:4317/api/reset >/dev/null; then
  echo "fixtures reset"
else
  echo "fixture reset failed; browser tasks will grade against a dirty database" >&2
fi

alive=()
for index in "${!CHOSEN[@]}"; do
  trim_if_low_mem
  name="${CHOSEN[$index]}"
  if [[ -f "${IMG}/${name}.dropped" ]]; then
    echo "skip ${name}"
    continue
  fi
  if wait_ssh "${name}" "$((24841 + index))"; then
    alive+=("${index}:${name}:${KINDS[$index]}")
    start_solver "${index}" "${name}" "${KINDS[$index]}"
  fi
done

if ((${#alive[@]})); then
  echo "solvers launched: ${alive[*]}"
else
  echo "solvers launched: none"
fi

deadline=$((SECONDS + 1800))
pending=()
if ((${#alive[@]})); then
  pending=("${alive[@]}")
fi
while (( SECONDS < deadline )) && (( ${#pending[@]} > 0 )); do
  trim_if_low_mem
  next=()
  for item in "${pending[@]}"; do
    index="${item%%:*}"
    rest="${item#*:}"
    name="${rest%%:*}"
    state="$(ssh_cmd "$((24841 + index))" "cat /tmp/osworld-status 2>/dev/null || true" 2>/dev/null || true)"
    state="${state//$'\r'/}"
    state="${state//$'\n'/}"
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
    rest="${item#*:}"
    name="${rest%%:*}"
    echo "----- ${name} -----"
    ssh_cmd "$((24841 + index))" "tail -n 50 /tmp/osworld.log /tmp/soffice.log" || true
  done
fi

printf '%s\n' "${CHOSEN[@]}" > "${ROOT}/runs/osworld-guests.txt"
echo "wall ready"
