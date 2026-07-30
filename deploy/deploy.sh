#!/usr/bin/env bash
# Recreate the API container. Prefers GHCR pull; falls back to local build.
# Called from GitHub Actions after image publish, or manually on the VPS.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env.prod ]]; then
  echo "Missing .env.prod — copy from .env.prod.example and fill secrets" >&2
  exit 1
fi

if docker compose -f docker-compose.prod.yml --env-file .env.prod pull api; then
  echo "==> Using pulled image"
else
  echo "==> Pull failed — building locally"
  docker compose -f docker-compose.prod.yml --env-file .env.prod build api
fi

echo "==> Recreate stack"
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --remove-orphans

echo "==> Prune dangling images"
docker image prune -f >/dev/null || true

echo "==> Status"
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
echo "DEPLOY_OK"
