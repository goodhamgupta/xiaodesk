# MicroVM boundary

## Production

One microVM per user. The image contains:

- a pinned `codex` binary (`codex app-server` on stdio)
- Lightpanda, `LIGHTPANDA_DISABLE_TELEMETRY=true`, CDP at `127.0.0.1:9222`
- a glibc userspace (Debian or Ubuntu)

The host scheduler does not run the agent. It boots the VM, connects the app-server stdio (or a vsock carrying the same JSON lines), and tears the VM down when the user session ends.

## This lab

One **guest per job**, so a queue of onboarding/ticket/booking tasks can share a machine. The host still does admission, RPC, eval, and teardown. Only the isolation technology changes.

| Driver | When |
| --- | --- |
| `drivers/process` | Default. Linux CI, this workspace, the stub demo. One Node process, stdio JSON-RPC, its own browser. |
| `drivers/docker` | Optional. `drivers/docker/Dockerfile` is a Debian skeleton, not a built image. Set `DOCKER_GUEST_IMAGE` when you have one. The class refuses to pretend a container started. |
| `drivers/microvm` | Stub. Calling it throws and points here. |

```bash
./scripts/run-demo.sh --driver process --exit
./scripts/run-demo.sh --driver docker --exit    # errors on purpose until you build an image
./scripts/run-demo.sh --driver microvm --exit   # errors on purpose
```

## Swapping in a Mac VMM

You do not need Mac hardware to finish this workshop. When you do have an Apple Silicon host, replace `MicrovmGuestDriver.start` with a boot of the same guest image. Two common mechanisms:

- **Virtualization.framework** (what Apple's container / VM stack uses). Boot a Linux guest, put the app-server socket on vsock or a serial pipe, map it to the stdio reader `StdioRpc` already uses.
- **libkrun** (used by `libkrun` / `krunkit` style microVMs). Same contract: the process the host speaks JSON-RPC to is `codex app-server` inside the VM, not a second protocol.

Keep these host-side:

- the job queue and the RAM admission numbers (24 GB machine, 6 GB reserve, ~700 MB per Lightpanda guest, cap 20–24)
- evals against the fixture world (or whatever environment the task pack points at)
- teardown when `turn/completed` arrives or the timeout fires

Do not put the queue inside the guest. A guest that admits its own siblings will oversubscribe the machine the host was trying to protect.

The process driver is the reference loop. A microVM driver that cannot pass `initialize` / `thread/start` / `turn/start` through to the guest is not done, even if the VM boots.
