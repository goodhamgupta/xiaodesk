#!/usr/bin/env bash
# Supervised inside every workshop-neko container.
#
# Xorg, Xfce, pulseaudio, and the neko server are already started by the base
# image's supervisord. This script adds the two things the workshop needs:
#   * x11vnc on 0.0.0.0:<NEKO_VNC_PORT> so the dashboard can bridge the screen
#   * cua-driver serve on the Xfce session bus, for Codex computer use
set -euo pipefail

export DISPLAY="${DISPLAY:-:99.0}"
export HOME="/home/neko"
export USER="neko"
export XDG_RUNTIME_DIR="/tmp/runtime-neko"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"
export NO_AT_BRIDGE=0
export GTK_MODULES="${GTK_MODULES:-gail:atk-bridge}"

vnc_port="${NEKO_VNC_PORT:-5930}"
display_number="${DISPLAY#:}"
display_number="${display_number%%.*}"
x_socket="/tmp/.X11-unix/X${display_number}"

mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.local/bin" "$HOME/Desktop" "$HOME/Downloads"
chmod 700 "$XDG_RUNTIME_DIR" 2>/dev/null || true

# Wait for Xorg before starting anything that needs a display.
for _ in $(seq 1 120); do
  if [[ -S "$x_socket" ]]; then break; fi
  sleep 0.5
done
if [[ ! -S "$x_socket" ]]; then
  echo "workshop-services: ${x_socket} never appeared" >&2
  exit 1
fi

# Reuse the bus that Xfce created. A plain `docker exec` shell normally has
# DBUS_SESSION_BUS_ADDRESS unset, which makes AT-SPI look empty.
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  session_pid="$(pgrep -u neko -f 'xfce4-session' | head -1 || true)"
  if [[ -n "$session_pid" ]]; then
    address="$(tr '\0' '\n' < "/proc/${session_pid}/environ" \
      | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p' | head -1)"
    if [[ -n "$address" ]]; then
      export DBUS_SESSION_BUS_ADDRESS="$address"
    fi
  fi
fi
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
  eval "$(dbus-launch --sh-syntax)"
fi

if [[ -x /usr/libexec/at-spi-bus-launcher ]]; then
  if ! pgrep -u neko -f at-spi-bus-launcher >/dev/null 2>&1; then
    /usr/libexec/at-spi-bus-launcher --launch-immediately >/tmp/at-spi-bus.log 2>&1 &
  fi
fi

# Cua Driver's Linux backend reads AT_SPI_BUS_ADDRESS directly. Ask the
# session bus for the accessibility bus instead of guessing a path.
if command -v dbus-send >/dev/null 2>&1; then
  for _ in $(seq 1 20); do
    atspi_address="$(dbus-send --session --dest=org.a11y.Bus --type=method_call --print-reply \
      /org/a11y/bus org.a11y.Bus.GetAddress 2>/dev/null \
      | sed -n 's/.*string "\(.*\)"/\1/p' | head -1 || true)"
    if [[ -n "$atspi_address" ]]; then
      export AT_SPI_BUS_ADDRESS="$atspi_address"
      break
    fi
    sleep 0.25
  done
fi

if ! pgrep -u neko -f "x11vnc.*-rfbport ${vnc_port}" >/dev/null 2>&1; then
  x11vnc \
    -display "$DISPLAY" \
    -auth "$XAUTHORITY" \
    -rfbport "$vnc_port" \
    -listen 0.0.0.0 \
    -nopw -shared -forever -noxdamage -repeat \
    >/tmp/x11vnc.log 2>&1 &
  sleep 0.5
fi

echo "workshop-services: display=${DISPLAY} vnc=${vnc_port} dbus=${DBUS_SESSION_BUS_ADDRESS:-unset} atspi=${AT_SPI_BUS_ADDRESS:-unset}"
cua_args=(serve)
if [[ "${CUA_DRIVER_PERMISSION_MODE:-standard}" == "unrestricted" ]]; then
  cua_args+=(--dangerously-bypass-approvals)
fi
exec "$HOME/.local/bin/cua-driver" "${cua_args[@]}"
