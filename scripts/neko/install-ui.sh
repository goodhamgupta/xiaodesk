#!/usr/bin/env bash
# Copy the desk skin into the running neko www root.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
name="${NEKO_NAME:-workshop-neko}"

docker_cmd() {
  if docker info >/dev/null 2>&1; then
    docker "$@"
  else
    sudo -n docker "$@"
  fi
}

docker_cmd cp "${ROOT}/scripts/neko/ui/desk.css" "${name}:/var/www/desk.css"
docker_cmd cp "${ROOT}/scripts/neko/ui/desk.js" "${name}:/var/www/desk.js"
docker_cmd exec "$name" sh -c 'grep -q "desk.js" /var/www/index.html || sed -i "s#</body>#<link rel=\"stylesheet\" href=\"desk.css?v=3\"><script src=\"desk.js?v=3\"></script></body>#" /var/www/index.html'
docker_cmd exec "$name" sh -c 'sed -i "s/desk.css?v=1/desk.css?v=3/; s/desk.js?v=1/desk.js?v=3/; s/desk.css?v=2/desk.css?v=3/; s/desk.js?v=2/desk.js?v=3/" /var/www/index.html'
echo "neko ui installed in ${name}"
