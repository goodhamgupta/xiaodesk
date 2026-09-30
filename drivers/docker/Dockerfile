# Optional guest image. Not required to run the stub workshop.
# glibc userland: Lightpanda's Linux builds are not musl/Alpine binaries.
FROM debian:bookworm-slim

ENV LIGHTPANDA_DISABLE_TELEMETRY=true \
    DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Pin Codex in the image you actually ship. Generate a matching client schema with:
#   codex app-server generate-ts --out /opt/codex-schema
# Install the pinned release here, for example:
#   COPY codex /usr/local/bin/codex
# Lightpanda CDP listens inside the VM/container, not on the host network:
#   COPY lightpanda /usr/local/bin/lightpanda
#   CMD ["lightpanda", "serve", "--host", "127.0.0.1", "--port", "9222"]

WORKDIR /guest
CMD ["bash", "-lc", "echo 'guest image skeleton; use the process driver for the lab' && sleep infinity"]
