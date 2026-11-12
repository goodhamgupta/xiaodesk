#!/usr/bin/env bash
# Copy the desk skin into the running neko www root.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
name="${NEKO_NAME:-workshop-neko}"

docker_cmd() {
  if [[ -n "${DOCKER_BIN:-}" ]]; then
    $DOCKER_BIN "$@"
  elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker "$@"
  elif command -v podman >/dev/null 2>&1; then
    podman "$@"
  else
    sudo -n docker "$@"
  fi
}

docker_cmd cp "${ROOT}/scripts/neko/ui/desk.css" "${name}:/var/www/desk.css"
docker_cmd cp "${ROOT}/scripts/neko/ui/desk.js" "${name}:/var/www/desk.js"
docker_cmd cp "${ROOT}/scripts/neko/xfce-dock.sh" "${name}:/tmp/xfce-dock.sh"
docker_cmd exec "$name" sh -c 'grep -q "desk.js" /var/www/index.html || sed -i "s#</body>#<link rel=\"stylesheet\" href=\"desk.css?v=5\"><script src=\"desk.js?v=5\"></script></body>#" /var/www/index.html'
docker_cmd exec "$name" sh -c 'sed -i "s/desk.css?v=[0-9][0-9]*/desk.css?v=5/; s/desk.js?v=[0-9][0-9]*/desk.js?v=5/" /var/www/index.html'
docker_cmd exec -u neko -e DISPLAY="${NEKO_DISPLAY:-:99.0}" "$name" bash /tmp/xfce-dock.sh
echo "neko ui installed in ${name}"
