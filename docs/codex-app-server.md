# Packaging Codex App Server

Codex App Server is the JSON-RPC interface Codex uses for rich clients (`codex app-server`). Upstream reference: the `codex-rs/app-server` README in [openai/codex](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md). Messages are JSON-RPC 2.0 **without** a `jsonrpc` field on the wire. Default transport is stdio, one JSON object per line.

This lab implements the subset the fan-out loop needs. It is not a full schema clone. Pin a Codex release and generate that release's types when you leave the mock.

## Pin it in the guest image

Do this inside the image you boot (Debian or Ubuntu, see [lightpanda.md](lightpanda.md)), not on the host orchestrator.

```bash
# Install the release you intend to run. Example only: use the version you just qualified.
codex --version

# Schema that matches THIS binary, not main's README.
codex app-server generate-ts --out /opt/codex-schema
codex app-server generate-json-schema --out /opt/codex-schema
```

Record the version in the image label or a `/opt/codex-version` file. The host client in `drivers/process/driver.ts` speaks the methods below. If a future Codex release renames fields, regenerate the schema and update the client. Do not float `main`.

Logs: stderr. `RUST_LOG` controls verbosity. The server rejects a saturated ingress with code `-32001` and `Server overloaded; retry later.` Treat that as retryable. This lab's host-level backpressure is admission control, which keeps you from opening that many guests in the first place.

## Handshake the runner actually sends

```json
{ "method": "initialize", "id": 1, "params": { "clientInfo": { "name": "microvm-workshop", "title": "MicroVM Workshop", "version": "1.0.0" } } }
{ "method": "initialized" }
{ "method": "thread/start", "id": 2, "params": { "cwd": "/workspace", "ephemeral": true } }
{ "method": "turn/start", "id": 3, "params": { "threadId": "thr_…", "input": [ { "type": "text", "text": "<job goal>" } ] } }
```

Then read notifications until `turn/completed`.

The mock (`packages/guest-agent/src/worker.ts`) replies with:

- `initialize` → `{ userAgent, platformFamily, platformOs }`
- `thread/start` → `{ thread: { id, ephemeral: true, path: null, status } }` plus `thread/started`
- `turn/start` → `{ turn: { id, threadId, status: "inProgress" } }` immediately, then `turn/started`, `item/completed` per stub step, then `turn/completed`

Requests before `initialized` get `Not initialized`. A second `initialize` gets `Already initialized`.

## Mock vs real

| | Mock (default) | `--app-server real` |
| --- | --- | --- |
| Process | `packages/guest-agent/src/worker.ts` | `codex app-server` (`CODEX_BIN` to override the name) |
| Who clicks the browser | Scripted stub in the guest | Codex, if you registered a browser tool |
| Credentials | None | Whatever that Codex build requires |
| Evals | Must pass in CI | Will fail the browser packs until the guest exposes CDP tools |

The job card is passed to the mock through `GUEST_JOB_JSON`. The real server does not read that variable. The goal text is the only thing `turn/start` sends, which is what a real server should see. Tool wiring (MCP or an in-guest browser tool that calls the CDP endpoint) is the piece you add in the image, not in the host queue.

```bash
CODEX_BIN=/opt/codex/bin/codex ./scripts/run-demo.sh --app-server real --jobs onboarding-001 --exit
```

Expect eval failures until the real agent can drive the fixture pages. The RPC session itself is the thing you are proving.

## What the stub does

`packages/guest-agent/src/stub/stub-agent.ts` has one script per pack:

- onboarding: fill name/email, pick the plan, accept terms, GET the welcome PDF (the cookie jar from signup is what makes the download count)
- support: set status, priority, assignee, tags, post the gold reply
- booking: apply the constraint filters, take the cheapest enabled venue, confirm a slot. With `force_slot_race`, mark that slot sold out after render and retry

Swap the stub for a model by replacing the body of `turn/start` in the worker, or by using `--app-server real`. Keep the evals. They do not care who clicked.
