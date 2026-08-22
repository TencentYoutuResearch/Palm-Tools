#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.sync.yml"
ENV_FILE="$SCRIPT_DIR/.env.sync"
ACTION="${1:-up}"

usage() {
  echo "Usage: $0 init|up|down|restart|logs|status|smoke"
}

require_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing $ENV_FILE. Run '$0 init', then set KODE_SYNC_DOMAIN and ACME_EMAIL." >&2
    exit 2
  fi
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

case "$ACTION" in
  init)
    if [[ -e "$ENV_FILE" ]]; then
      echo "$ENV_FILE already exists; left unchanged."
    else
      cp "$SCRIPT_DIR/.env.sync.example" "$ENV_FILE"
      chmod 600 "$ENV_FILE"
      echo "Created $ENV_FILE. Edit the domain and email before running up."
    fi
    ;;
  up)
    require_env
    cd "$PROJECT_DIR"
    compose up -d --build
    compose ps
    ;;
  down)
    require_env
    compose down
    ;;
  restart)
    require_env
    compose restart sync-server caddy
    compose ps
    ;;
  logs)
    require_env
    compose logs --tail=200 -f
    ;;
  status)
    require_env
    compose ps
    ;;
  smoke)
    require_env
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    curl --fail --silent --show-error --max-time 10 \
      "https://${KODE_SYNC_DOMAIN}/api/v1/healthz"
    echo
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
