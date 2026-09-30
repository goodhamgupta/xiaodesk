#!/bin/bash
# Install a real X desktop on the QEMU VGA device so the VM framebuffer
# shows the browser, not a serial log. Debian cloud images boot to ttyS0;
# this session is what VNC screen-share captures.
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update
sudo apt-get install -y \
  xserver-xorg-core \
  xserver-xorg-video-vesa \
  xserver-xorg-video-fbdev \
  xserver-xorg-input-libinput \
  xinit \
  openbox \
  x11-xserver-utils \
  x11-utils \
  fonts-dejavu-core \
  dbus-x11

sudo tee /etc/X11/xorg.conf.d/10-vm.conf >/dev/null <<'EOF'
Section "Device"
  Identifier "Card0"
  Driver "vesa"
EndSection
Section "Monitor"
  Identifier "Monitor0"
EndSection
Section "Screen"
  Identifier "Screen0"
  Device "Card0"
  Monitor "Monitor0"
  DefaultDepth 24
  SubSection "Display"
    Depth 24
    Modes "1280x800" "1024x768"
  EndSubSection
EndSection
EOF

sudo tee /etc/workshop-xinitrc >/dev/null <<'EOF'
#!/bin/sh
xhost +local:
xsetroot -solid '#0b1020'
exec openbox
EOF
sudo chmod 755 /etc/workshop-xinitrc

sudo tee /etc/systemd/system/workshop-display.service >/dev/null <<'EOF'
[Unit]
Description=Workshop VM display
After=systemd-user-sessions.service
Conflicts=getty@tty1.service

[Service]
Type=simple
ExecStart=/usr/bin/xinit /etc/workshop-xinitrc -- /usr/bin/Xorg :0 vt7 -nolisten tcp -keeptty -noreset
Restart=on-failure
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable workshop-display.service
sudo systemctl restart workshop-display.service

ok=0
for _ in $(seq 1 40); do
  if DISPLAY=:0 xdpyinfo >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done
if [[ "${ok}" != 1 ]]; then
  echo "Xorg did not come up" >&2
  sudo journalctl -u workshop-display.service --no-pager -n 80 >&2 || true
  exit 1
fi
echo "display ready"
DISPLAY=:0 xdpyinfo | head -n 20 || true
sync
