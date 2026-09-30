# Lightpanda

Use Lightpanda for this lab's browser, not Cloudflare Kitesurf. Kitesurf is Workers browser rendering. It does not run inside a local microVM or a guest process on a Mac. Lightpanda is a headless browser you start yourself and attach to over CDP.

Upstream: [lightpanda-io/browser](https://github.com/lightpanda-io/browser).

## What it is good at

DOM and JS automation through CDP (`connectOverCDP` from Playwright or Puppeteer). That is the whole demo: forms, filters, tickets, downloads.

It is not a full Chrome, and it is not the OSWorld desktop loop (screenshot, pixel click, OS accessibility tree). Do not sell this workshop as computer-use. The label is **browser-use over CDP**.

## Guest OS

Linux release binaries are linked against **glibc**. On Alpine/musl they fail with a misleading "not found" because the dynamic linker is missing. Use Debian or Ubuntu in the guest image (`debian:bookworm-slim`, `ubuntu:24.04`). The optional Dockerfile at `drivers/docker/Dockerfile` starts from Debian for that reason.

Nightly builds are published for Linux x86_64 and macOS aarch64. Download the asset that matches the guest, not the host, when those differ.

## Run it

```bash
export LIGHTPANDA_DISABLE_TELEMETRY=true
./lightpanda serve --host 127.0.0.1 --port 9222
```

Telemetry is on unless that variable is set. Set it in the guest image, the systemd unit, and any Docker `environment:` block.

Inside a microVM the port is in the guest network namespace, so every VM can bind `127.0.0.1:9222` without colliding. The host reaches the guest through the VM's vsock or a forwarded port, not by sharing one 9222 across users.

Docker, if you want it instead of a raw binary:

```bash
docker run --rm -e LIGHTPANDA_DISABLE_TELEMETRY=true -p 127.0.0.1:9222:9222 lightpanda/browser:nightly
```

Memory: budget **600–800 MB per guest**. This repo uses 700 MB in admission math.

## Lab flags

Default demo does not download Lightpanda. Each guest launches Playwright Chromium.

```bash
# Try Lightpanda, fall back to Chromium and say so on stderr.
./scripts/run-demo.sh --browser lightpanda --exit

# One shared CDP endpoint (keep concurrency at 1; guests would share a browser).
LIGHTPANDA_CDP=http://127.0.0.1:9222 ./scripts/run-demo.sh --browser lightpanda --concurrency 1 --jobs onboarding-001 --exit

# Start a binary per guest on CDP_PORT. The worker sets LIGHTPANDA_DISABLE_TELEMETRY.
LIGHTPANDA_BIN=/usr/local/bin/lightpanda ./scripts/run-demo.sh --browser lightpanda --exit

# Fail the guest if Lightpanda is down. No silent Chromium.
ALLOW_CHROMIUM_FALLBACK=false ./scripts/run-demo.sh --browser lightpanda --exit
```

Fallback log line: `Lightpanda unavailable (...). Falling back to Playwright Chromium.`

Chromium is a dev/CI stand-in so the stub and the evals run without the binary. It is heavier than Lightpanda. Do not use the 20-guest Mac budget numbers with 20 Chromium processes.
