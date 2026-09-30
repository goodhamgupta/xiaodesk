# Lab brief

**Audience.** People who already know why you put each user in their own microVM. This session is about what you put *inside* it, and how the host schedules many short jobs.

**You will leave able to:**

- Pin `codex app-server` in a glibc guest and drive it with `initialize`, `thread/start`, and `turn/start`.
- Point that guest at Lightpanda CDP on `127.0.0.1:9222`, with a Chromium fallback that is obvious in the logs.
- Size a 24 GB Mac: 6 GB host reserve, ~700 MB per Lightpanda guest, 20–24 concurrent.
- Explain why a sold-out slot and a full RAM budget are different backoffs (guest retry vs host queue).
- Add a job card whose pass/fail is a SQL row or an HTTP body.

**You will not:**

- Build a VMM.
- Use NVIDIA OpenShell.
- Grade tasks with an LLM.
- Scrape the public web.
- Paste an API key to see a green run.

**Stack.** TypeScript, pnpm, Express fixtures, SQLite, Playwright. Stub agent by default.

**Run.** `./scripts/bootstrap.sh` then `./scripts/run-demo.sh --low-ram --exit`.

**Read next.** [demo-script.md](demo-script.md) for the timed walkthrough, [architecture.md](architecture.md) for the control loop.
