#!/usr/bin/env bash
# Run on the VPS (requires sudo password interactively):
#   ssh myvps-tunnel
#   ~/waze-nca-scanner/deploy/install-nginx.sh
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
sudo cp "$DIR/nginx-waze-nca-scanner.conf" /etc/nginx/sites-available/waze-nca-scanner
sudo ln -sf /etc/nginx/sites-available/waze-nca-scanner /etc/nginx/sites-enabled/waze-nca-scanner
sudo nginx -t
sudo systemctl reload nginx
if [[ ! -d /etc/letsencrypt/live/waze-nca-scanner.ster.by ]]; then
  sudo certbot --nginx -d waze-nca-scanner.ster.by --non-interactive --agree-tos --register-unsafely-without-email --redirect \
    || sudo certbot --nginx -d waze-nca-scanner.ster.by
fi
echo "NGINX_OK — https://waze-nca-scanner.ster.by/"
