#!/bin/bash
# The neko image is XFCE. Panel 2 is the launcher dock (terminal, files, browser).
# autohide-behavior 2 keeps it collapsed until the pointer hits that screen edge.
set -eu
export DISPLAY="${DISPLAY:-:99.0}"
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S /tmp/runtime-neko/bus ]]; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-neko}"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
fi
xfconf-query -c xfce4-panel -p /panels/panel-2/autohide-behavior -n -t uint -s 2
xfconf-query -c xfce4-panel -p /panels/panel-2/enable-struts -n -t bool -s false >/dev/null 2>&1 || true
if [[ "${XFCE_DOCK_RESTART:-1}" == 1 ]]; then
  xfce4-panel -r >/dev/null 2>&1 || true
fi
echo "xfce launcher dock autohides until hover"
