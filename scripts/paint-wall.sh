#!/usr/bin/env bash
# Open each running wall guest's Chrome page or Calc sheet on DISPLAY=:0.
# Empty Openbox (#0b1020) is what a blank tile on /vms looks like.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY="${ROOT}/images/guest_ed25519"
CONTROL="${ROOT}/runs/vm-control.json"
if [[ ! -f "${CONTROL}" ]]; then
  echo "no ${CONTROL}; boot the wall first" >&2
  exit 1
fi

ssh_cmd() {
  local port="$1"
  shift
  ssh -i "${KEY}" -p "${port}" \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    -o IdentitiesOnly=yes \
    -o BatchMode=yes \
    -o ConnectTimeout=8 \
    lume@127.0.0.1 "$@"
}

scp_to() {
  local port="$1" src="$2" dest="$3"
  scp -i "${KEY}" -P "${port}" \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes \
    "${src}" "lume@127.0.0.1:${dest}"
}

stamp_task() {
  local src="$1" dest="$2"
  python3 - "${src}" "${dest}" <<'PY'
import json, sys
task = json.load(open(sys.argv[1]))
task["fixtures_url"] = "http://10.0.2.2:4317"
json.dump(task, open(sys.argv[2], "w"))
PY
}

mapfile -t WANTED < <(python3 - "${CONTROL}" "$@" <<'PY'
import json, sys
control = json.load(open(sys.argv[1]))
names = sys.argv[2:]
if not names:
    names = list(control)
missing = [name for name in names if name not in control]
if missing:
    raise SystemExit(f"not in vm-control: {', '.join(missing)}")
for name in names:
    row = control[name]
    print(f"{name} {row['sshPort']}")
PY
)

fail=0
for row in "${WANTED[@]}"; do
  name="${row%% *}"
  port="${row##* }"
  task_src="${ROOT}/tasks/osworld/${name}.json"
  task_json="/tmp/${name}.task.json"
  if [[ ! -f "${task_src}" ]]; then
    echo "no task card for ${name}" >&2
    fail=1
    continue
  fi
  echo "painting ${name}"
  ssh_cmd "${port}" 'if ! command -v xterm >/dev/null 2>&1 || ! command -v pcmanfm >/dev/null 2>&1; then sudo -n DEBIAN_FRONTEND=noninteractive apt-get install -y xterm pcmanfm; fi' \
    || echo "desk apps missing on ${name}" >&2
  stamp_task "${task_src}" "${task_json}"
  scp_to "${port}" "${ROOT}/scripts/guest/paint-desktop.mjs" "/tmp/paint-desktop.mjs"
  scp_to "${port}" "${task_json}" "/tmp/${name}.task.json"
  if ssh_cmd "${port}" "node /tmp/paint-desktop.mjs /tmp/${name}.task.json"; then
    echo "painted ${name}"
  else
    echo "paint failed on ${name}" >&2
    fail=1
  fi
done
exit "${fail}"
