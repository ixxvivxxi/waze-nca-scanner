#!/usr/bin/env bash
# Run on the VPS from ~/waze-nca-scanner (after syncing this repo).
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env.prod ]]; then
  echo "Missing .env.prod — copy from .env.prod.example and fill secrets" >&2
  exit 1
fi

echo "==> Build API image"
docker compose -f docker-compose.prod.yml --env-file .env.prod build api

echo "==> Recreate stack"
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --remove-orphans

echo "==> Status"
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
echo "DEPLOY_OK"
