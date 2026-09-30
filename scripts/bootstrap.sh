#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install
pnpm exec playwright install chromium
echo "Bootstrap complete. Next: ./scripts/run-demo.sh"
