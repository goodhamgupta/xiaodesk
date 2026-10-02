#!/usr/bin/env bash
# Run inside the neko container as root. Installs Firefox, AT-SPI, and
# cua-driver for the desktop user, then leaves `cua-driver serve` running.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y curl ca-certificates libxi6 at-spi2-core scrot firefox-esr dbus-x11 python3
install -d -o neko -g neko /home/neko/Desktop /home/neko/Downloads /home/neko/.local/bin /tmp/runtime-neko
chmod 700 /tmp/runtime-neko
chown neko:neko /tmp/runtime-neko
if ! su -s /bin/bash neko -c 'test -x "$HOME/.local/bin/cua-driver"'; then
  su -s /bin/bash neko -c 'curl -fsSL https://cua.ai/driver/install.sh | bash'
fi
if ! su -s /bin/bash neko -c 'pgrep -u neko -f "cua-driver serve" >/dev/null'; then
  su -s /bin/bash neko -c 'export DISPLAY="${DISPLAY:-:99.0}" HOME=/home/neko XDG_RUNTIME_DIR=/tmp/runtime-neko; mkdir -p "$XDG_RUNTIME_DIR"; nohup "$HOME/.local/bin/cua-driver" serve >>/tmp/cua-driver.log 2>&1 &'
fi
if [[ -x /usr/bin/xfconf-query ]]; then
  su -s /bin/bash neko -c 'export DISPLAY="${DISPLAY:-:99.0}"; export XFCE_DOCK_RESTART=0; bash /workspace/scripts/neko/xfce-dock.sh' \
    || echo "xfce dock autohide skipped"
fi
if [[ -x /opt/openclaw/bin/openclaw && -f /workspace/scripts/neko/openclaw-node.sh ]]; then
  bash /workspace/scripts/neko/openclaw-node.sh >>/tmp/openclaw-node-setup.log 2>&1 &
fi
echo "cua-driver ready"
