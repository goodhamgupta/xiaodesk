# Demo script (about 40 minutes)

Run this on a laptop. Stub mode. No API key.

## 0. Before the room (5 min, offstage)

```bash
./scripts/bootstrap.sh
./scripts/run-demo.sh --driver process --jobs onboarding-001,support-001,booking-008 --exit
```

That slice must be all passes. The VM path is section 5 (`--driver lume` after `./scripts/build-guest-image.sh`). Leave a terminal ready with the full process-driver command; it finishes in about a minute.

## 1. What this is (5 min)

Say this out loud:

- OpenShell is a sandbox product. This is a workshop about the guest image and the host queue.
- Production is one microVM per user. The default driver boots that guest with lume (Virtualization.framework) or QEMU. The 24-job room demo uses `--driver process` so a laptop is not asked to run 24 Debian VMs.
- The browser path is CDP. Lightpanda when the binary exists. Chromium otherwise. Not desktop computer-use.

Open [http://127.0.0.1:4317](http://127.0.0.1:4317) after the demo command has started the fixtures, or start them with `pnpm fixtures`. Click the three apps. Do not spend time on the CSS.

## 2. One job card (8 min)

Open `tasks/support.yaml` at `support-001`.

- Goal is the prompt the agent sees (`turn/start` text).
- Eval is SQL: status, assignee, tags, reply body.
- Reset with `./scripts/reset-fixtures.sh` if you hand-edited a ticket.

Open `tasks/booking.yaml` at `booking-008`. The params include `force_slot_race: true`. The stub marks the first matching slot unavailable after the page has rendered, submits, sees `slot_unavailable`, waits, and takes the next slot. The eval still requires date, party size, accessibility, and price.

## 3. App server messages (7 min)

Open `packages/guest-agent/src/worker.ts` and `drivers/process/driver.ts`.

Walk the three calls only:

1. `initialize` then the `initialized` notification.
2. `thread/start`.
3. `turn/start` with `{ threadId, input: [{ type: "text", text: goal }] }`.

Notifications come back as `item/completed` and `turn/completed`. The wire format omits the `jsonrpc` field, matching `codex app-server`. `--app-server real` swaps the child process for the real binary. Do not flip it in the demo unless a pinned `codex` is installed.

## 4. Fan-out and backpressure (10 min)

```bash
./scripts/run-demo.sh --low-ram
```

Open [http://127.0.0.1:4318](http://127.0.0.1:4318). Queue depth stays high while two guests run. The terminal prints `backpressure: ...` when admission closes. At the end, `peak concurrent guests` is 2, not 24.

Show the budget in `packages/orchestrator/src/admission/memory-controller.ts`:

- 24 GB Mac, 6 GB host reserve, 700 MB guest → 20–24 is the knob (`--concurrency 20`).
- `--low-ram` is 2000 MB total, 600 MB reserve, 700 MB guest → 2.

Do not launch 20 Chromium processes to make the point. The unit test `fan-out-runner.test.ts` is the same gate with a fake driver.

## 5. Where the VM runs (5 min)

`./scripts/build-guest-image.sh` once, then:

```bash
./scripts/run-demo.sh --driver lume --jobs onboarding-001 --concurrency 1 --exit
```

Read `docs/microvm.md` and `docs/agents-api.md`. On a Mac this is `lume` / Virtualization.framework. On Linux it is QEMU. The guest runs `codex exec-server --remote … --environment-id …`. The host deletes the session and stops the VM as two separate steps.

Stop on this sentence: the host queue does not move into the VM. Admission stays on the host, because the host is the thing that runs out of RAM.

## If something fails

- Fixture data looks stale: `./scripts/reset-fixtures.sh`.
- Browser missing: `pnpm exec playwright install chromium`.
- A single pack: `./scripts/run-demo.sh --jobs booking-008 --exit`.
- Dashboard port busy: `DASHBOARD_PORT=4320 ./scripts/run-demo.sh`. The Agents API listens on 4319.
