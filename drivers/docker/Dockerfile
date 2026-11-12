# Workshop desktop image: neko Xfce + the lab guest-agent + real Codex + Cua Driver.
#
# Build:
#   podman build -t workshop-neko:desk -f drivers/docker/Dockerfile .
#   docker build -t workshop-neko:desk -f drivers/docker/Dockerfile .
#
# The image is multi-arch: the Codex release below is a static musl binary for
# both linux/amd64 and linux/arm64. Pin CODEX_VERSION and the matching SHA256.

FROM ghcr.io/m1k1o/neko/xfce:latest

ARG TARGETARCH
ARG CODEX_VERSION=0.167.1
ARG CODEX_SHA256_AMD64=a945df3df83e849dd7b74787e27f8a459c1946b0e3afe3dc8eef8a8d1845fd4f
ARG CODEX_SHA256_ARM64=ef3e1443a7795d596f1601a533d7225a1030488d60c965af1f0610ab95889031
ARG NODE_VERSION=22.14.0
ARG CUA_DRIVER_VERSION=0.47.5

USER root
ENV DEBIAN_FRONTEND=noninteractive \
    NEKO_VNC_PORT=5930 \
    CUA_DRIVER_PERMISSION_MODE=unrestricted

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl xz-utils git build-essential python3 python3-setuptools \
      at-spi2-core dbus-x11 libxi6 scrot firefox-esr x11vnc xdotool \
    && rm -rf /var/lib/apt/lists/*
ENV SETUPTOOLS_USE_DISTUTILS=local

# Linux Node is needed by the lab's exec-server shim. Do not bind-mount the
# host's Node binary: on macOS that is a Darwin executable and cannot run here.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/node.tar.xz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1; \
    rm -f /tmp/node.tar.xz; \
    node -v; \
    corepack enable; \
    corepack prepare pnpm@8.15.0 --activate; \
    pnpm -v

# Real Codex CLI. /usr/local/bin/codex is the model/app-server CLI.
# /workspace/bin/codex remains the lab's exec-server shim.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) asset="codex-package-x86_64-unknown-linux-musl.tar.gz"; sha="${CODEX_SHA256_AMD64}" ;; \
      arm64) asset="codex-package-aarch64-unknown-linux-musl.tar.gz"; sha="${CODEX_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLo /tmp/codex.tar.gz \
      "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${asset}"; \
    echo "${sha}  /tmp/codex.tar.gz" | sha256sum -c -; \
    install -d /opt/codex; \
    tar -xzf /tmp/codex.tar.gz -C /opt/codex; \
    rm -f /tmp/codex.tar.gz; \
    ln -sf /opt/codex/bin/codex /usr/local/bin/codex; \
    ln -sf /opt/codex/bin/codex-exec-server /usr/local/bin/codex-exec-server; \
    ln -sf /opt/codex/bin/codex-code-mode-host /usr/local/bin/codex-code-mode-host; \
    codex --version

WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts ./
COPY apps/fixtures/package.json apps/fixtures/
COPY packages/agents-api/package.json packages/agents-api/
COPY packages/evals/package.json packages/evals/
COPY packages/guest-agent/package.json packages/guest-agent/
COPY packages/orchestrator/package.json packages/orchestrator/
RUN pnpm install --frozen-lockfile
RUN pnpm --filter guest-agent exec playwright install --with-deps chromium

COPY . .
RUN chmod 0755 /workspace/bin/codex \
      /workspace/scripts/neko/container-services.sh \
      /workspace/scripts/neko/cua-driver-mcp.sh

# Cua Driver for the desktop user. The daemon runs on DISPLAY=:99.0 as neko.
RUN install -d -o neko -g neko \
      /home/neko/.codex /home/neko/.local/bin /home/neko/Desktop \
      /home/neko/Downloads /tmp/runtime-neko \
    && chmod 700 /tmp/runtime-neko \
    && chown neko:neko /tmp/runtime-neko \
    && su -s /bin/bash neko -c 'export CUA_DRIVER_RS_VERSION='"${CUA_DRIVER_VERSION}"'; curl -fsSL https://cua.ai/driver/install.sh | bash -s -- --no-connect --no-test'

COPY scripts/neko/codex-config.toml /home/neko/.codex/config.toml
COPY scripts/neko/workshop-fixtures.sh /usr/local/bin/workshop-fixtures
COPY scripts/neko/MicroVM-Workshop.desktop /home/neko/Desktop/MicroVM-Workshop.desktop
RUN chown neko:neko /home/neko/.codex/config.toml /home/neko/Desktop/MicroVM-Workshop.desktop \
    && chmod 600 /home/neko/.codex/config.toml \
    && chmod 755 /usr/local/bin/workshop-fixtures \
    && chmod 755 /home/neko/Desktop/MicroVM-Workshop.desktop

# x11vnc + cua-driver are supervised next to Xorg/Xfce.
COPY scripts/neko/supervisord-workshop.conf /etc/neko/supervisord/workshop.conf
RUN chmod 0644 /etc/neko/supervisord/workshop.conf

# Keep the base image's command: supervisord starts Xorg, Xfce, neko, and our
# workshop-services program.
