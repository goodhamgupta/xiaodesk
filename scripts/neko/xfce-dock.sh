#!/bin/bash
# The neko image is XFCE. Panel 2 is the launcher dock (terminal, files, browser).
# autohide-behavior 2 keeps it collapsed until the pointer hits that screen edge.
set -eu
export DISPLAY="${DISPLAY:-:99.0}"
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/tmp/runtime-neko}"
  if [[ -S "${XDG_RUNTIME_DIR}/bus" ]]; then
    export DBUS_SESSION_BUS_ADDRESS="unix:path=${XDG_RUNTIME_DIR}/bus"
  else
    # This image's xfce4-session bus is /tmp/dbus-*, not $XDG_RUNTIME_DIR/bus.
    session_pid="$(pgrep -u "$(id -u)" -x xfce4-session | head -1 || true)"
    if [[ -n "${session_pid}" && -r "/proc/${session_pid}/environ" ]]; then
      addr="$(tr '\0' '\n' < "/proc/${session_pid}/environ" | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p' | head -1)"
      if [[ -n "${addr}" ]]; then
        export DBUS_SESSION_BUS_ADDRESS="${addr}"
      fi
    fi
  fi
fi
xfconf-query -c xfce4-panel -p /panels/panel-2/autohide-behavior -n -t uint -s 2
xfconf-query -c xfce4-panel -p /panels/panel-2/enable-struts -n -t bool -s false >/dev/null 2>&1 || true
if [[ "${XFCE_DOCK_RESTART:-1}" == 1 ]]; then
  xfce4-panel -r >/dev/null 2>&1 || true
fi
echo "xfce launcher dock autohides until hover"
