# MicroVM boundary

## Production

One microVM per user. The image contains Codex (`codex exec-server` for a self-hosted Agents API environment, or `codex app-server` on stdio) and a CDP browser. The host does not run the agent. It boots the VM, waits until `session.environment` is `connected`, and stops the VM itself. Deleting the session does not do that.

## This lab

One guest per job. The host still owns the queue, RAM admission, evals, and teardown.

| Driver | When |
| --- | --- |
| `drivers/lume` | Default. Apple Silicon uses the `lume` CLI, which drives Virtualization.framework. Linux uses QEMU. KVM when a probe actually reaches SeaBIOS; this workspace's nested KVM faults (`kvm_spurious_fault`), so the image build records `images/qemu-accel` as `tcg` and guests boot with TCG. |
| `drivers/microvm` | Same class as `lume`. The old throw-stub is gone. |
| `drivers/process` | Fast path. One Node process, stdio JSON-RPC, no VM. Use this for the 24-job fan-out on a small machine. |
| `drivers/docker` | Optional Debian skeleton. Refuses to pretend a container started until `DOCKER_GUEST_IMAGE` is set. |

```bash
./scripts/build-guest-image.sh          # Debian 12 + Node 22 + Chromium libs, once
./scripts/run-demo.sh --driver lume --jobs onboarding-001,support-001,booking-008 --concurrency 1 --exit
./scripts/run-demo.sh --driver process --low-ram --exit
```

A guest is a full Debian VM, about 1536 MB, not a 700 MB Lightpanda process. Default VM admission is one guest (8 GB budget, 4 GB host reserve). Raise `--concurrency` on a 24 GB Mac only after you have measured the RSS. Do not aim 20 of these VMs at a laptop that was sized for 700 MB guests.

## Apple Silicon (lume / Virtualization.framework)

`lume` has to be on `PATH`. The driver runs:

```bash
lume create <name> --os linux --cpu 2 --memory 2GB --disk-size 12GB
lume run <name> --display none --detach
lume ssh <name> -- bash -s
lume stop <name>
```

The guest still starts `codex exec-server --remote <session.environment.remote_url> --environment-id <session.environment.id>`. Set `LUME_HOST_IP` to the address the VM uses to reach the host (fixtures and the Agents API). The Linux QEMU path uses `10.0.2.2` (user-mode networking). If `lume` is missing, the driver throws. It does not pretend a VM started.

This lab does not link Virtualization.framework itself. `lume` is that integration.

## Linux guest image

`scripts/build-guest-image.sh` copies `images/debian-12-genericcloud-amd64.qcow2`, grows it to 12 GB, and cloud-inits a `lume` user with the lab SSH key. The Debian cloud kernel has no 9p, so the provisioner `scp`s in the official Node 22.14.0 tarball (the host Node is built against a newer glibc than Debian 12), the guest-agent workspace, and the Playwright browser build, then runs `playwright install-deps chromium`.

Each job gets a qcow2 overlay of that image. `FIXTURES_URL` inside the guest is `http://10.0.2.2:4317`. The executor dials `ws://10.0.2.2:4319/v1/agents/api`.

The guest framebuffer is the dashboard. QEMU serves the VGA device on VNC (`share=force-shared`, no local window). On a Mac, `lume run --display none --vnc-port <port>` keeps Virtualization.framework's VNC server up. The dashboard proxies that socket to the browser and draws it with noVNC. Double-click a tile to open that VM's screen full size. `./scripts/enable-guest-display.sh` installs an X session on the VGA device and the stub browser runs headed on `DISPLAY=:0`, so the screen share shows the pages being driven, not a serial log.

## What stays on the host

- the job queue and the RAM admission numbers
- evals against the fixture SQLite file and HTTP API
- `DELETE` session, then `lume stop` / kill QEMU

Do not put the queue inside the guest.
