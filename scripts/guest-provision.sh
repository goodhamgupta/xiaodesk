#!/bin/bash
# Runs inside the Debian guest during image build.
# The host has already scp'd node, a workspace tarball, and the Playwright browsers to /tmp.
# Debian cloud kernels do not ship 9p, so the files live on the guest disk.
set -euxo pipefail

sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
sudo mkdir -p /workspace /opt/ms-playwright
sudo tar -xzf /tmp/workspace.tgz -C /workspace
sudo tar -xzf /tmp/playwright.tgz -C /opt/ms-playwright
sudo chmod -R a+rX /workspace /opt/ms-playwright
/usr/local/bin/node -v

CLI="$(find /workspace/node_modules/.pnpm -path '*/node_modules/playwright/cli.js' | head -1)"
if [[ -z "${CLI}" ]]; then
  echo "playwright cli.js missing from /workspace" >&2
  exit 1
fi
sudo /usr/local/bin/node "${CLI}" install-deps chromium

CHROME="$(find /opt/ms-playwright -type f -path '*/chrome-linux64/chrome' | head -1)"
if [[ -z "${CHROME}" ]]; then
  echo "chromium binary missing after extract" >&2
  exit 1
fi
timeout 180 "${CHROME}" --headless=new --no-sandbox --disable-gpu --dump-dom about:blank >/tmp/chrome-smoke.html
test -s /tmp/chrome-smoke.html
echo "provision ok: $(/usr/local/bin/node -v) chrome=${CHROME}"
sync
