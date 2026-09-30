# Agents API environment lifecycle

The VM path follows the [self-hosted sandbox lifecycle](https://developers.openai.com/api/docs/guides/agents-api/environments/lifecycle). This lab runs that control plane locally. The happy path does not call OpenAI and does not need a paid key.

`packages/agents-api` is the stand-in for `client.beta.agents.sessions`. Override the lab credentials with `OPENAI_API_KEY`, `OPENAI_EXECUTOR_API_KEY`, and `OPENAI_WEBHOOK_SECRET` if you want to point the same driver at the real API later. Defaults are `lab-app`, `lab-executor`, and a built-in `whsec_` secret.

## What the application does

1. `POST /v1/agents/sessions` with `environment.type: "self_hosted"` and `workspace_directory: "/workspace"`.
2. Keep `session.id`, `session.environment.id` (`ccarenv_…`), and `session.environment.remote_url`. Reuse that URL unchanged, including on reconnect.
3. Open the session event stream (`GET /v1/agents/sessions/:id/events`, or the in-process stream the driver uses).
4. `POST /v1/agents/sessions/:id/input`.

If the executor is not connected, the API adds `required_actions[].type = environment_connection`, emits `agent.session.requires_action` on the stream, and POSTs a signed `agent.session.action_required` webhook. The webhook body does not include `connect.remote_url`. The worker `GET`s the session and reads `environment.id` and `environment.remote_url`.

The API waits five minutes (`connectionWaitMs`, 300000). If that expires, the submission fails and the session goes to `failed` (`agent.session.failed`). A late executor does not get the timed-out input again. A second `POST /input` while the first is still waiting returns 409.

## Webhook worker

`POST /webhooks/openai` checks the Standard Webhooks signature (`webhook-id`, `webhook-timestamp`, `webhook-signature` = `v1,<base64 hmac-sha256>` over `id.timestamp.body`, secret base64-decoded after stripping `whsec_`). It returns 200 only after the event is queued. The HTTP handler does not boot a VM.

The worker then:

| Event | Action |
| --- | --- |
| `agent.session.action_required` and `data.required_action.type == environment_connection` | Retrieve the session. Ignore it if it was deleted or the action is already gone. Otherwise start one executor. |
| `agent.session.action_required` and `function_call` or `computer_use_approval_request` | Do not start compute. |
| `agent.session.failed` | Release compute if the session is still failed. |
| `agent.session.idle`, `in_progress`, `created` | Do not start or stop compute. Idle can fire when a connection request clears, before the turn starts. |

Concurrent deliveries for the same environment id share one boot (`DedupedCompute`).

## Executor

Inside the guest:

```bash
CODEX_API_KEY="$OPENAI_EXECUTOR_API_KEY" \
  codex exec-server \
  --remote "<session.environment.remote_url>" \
  --environment-id "<session.environment.id>"
```

`bin/codex` is the lab binary. It dials the `remote_url` WebSocket with the executor key and registers `{ "type": "register", "environment_id" }`. The real Codex binary speaks a Noise relay after that; the frame format is not published, so this lab uses a small JSON command channel with the same CLI flags:

- server → executor `{ "type": "command", "id", "name": "run_job", "input", "job" }`
- executor → server `{ "type": "event", ... }` and `{ "type": "command_result", "id", "ok" }`

`run_job` is the lab harness standing in for the shell and browser RPCs the hosted harness would send. It runs the same stub agent as the process driver. The executor key cannot create sessions. The application key cannot open the executor socket.

Stream events you should key off:

- `agent.session.environment.pending|connected|disconnected|failed` report state. They do not request compute.
- `agent.session.in_progress` means the turn started, not that the API is waiting for a connection.
- `agent.session.turn.completed|failed|cancelled` is the turn outcome. A failed turn does not mark the session failed.
- A mid-turn socket drop emits `environment.disconnected` and `turn.failed`. It does not ask for a new VM and it does not rerun the command.

## Shutdown

`DELETE /v1/agents/sessions/:id` does not stop the VM and emits no deletion webhook. `LumeGuestDriver.stop` deletes the session, then stops compute as a second step.

`ENVIRONMENT_GRACE_MS` (default 0) is the optional idle grace period. A pending stop is cancelled when `requires_action` or `in_progress` arrives. Leave it at 0 unless you want reuse across turns. The demo stops the VM explicitly after evals.
