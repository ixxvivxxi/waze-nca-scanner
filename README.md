# Waze NCA Scanner

NestJS service that scans [map.nca.by](https://map.nca.by/) (WFS) and stores address points / land parcels in **Postgres + PostGIS**. WME userscript draws nearby addresses on the map.

| Piece | Path | Role |
|-------|------|------|
| API | [`server/`](server/) | NestJS + TypeORM + scheduled WFS scan |
| Deploy | [`deploy/`](deploy/) | Docker Compose on VPS + nginx snippet |
| Userscript | [`wme-nca-addresses-nearby.user.js`](wme-nca-addresses-nearby.user.js) | Also mirrored in `wme-scripts` |

**Production:** `https://waze-nca-scanner.ster.by` (Let's Encrypt)

## API

- `GET /` — health `{ ok, service: "nca-scanner" }`
- `GET /api/addresses/nearby?lon&lat&radiusM&limit`
- `GET /api/addresses/bbox?minLon&minLat&maxLon&maxLat`
- `GET /viewer` — admin map UI + GeoJSON endpoints under `/api/viewer/*`

CORS allows `www`/`beta`.waze.com. Outbound WFS needs `Referer: https://map.nca.by/`.

## Local server

```bash
cd server
cp .env.example .env
docker compose up -d          # PostGIS on localhost:5433
npm install
npm run migration:run
npm run start:dev             # http://127.0.0.1:3000
```

## Manual deploy (VPS)

SSH host **`myvps-tunnel`**, user **`ster`**, app path `~/waze-nca-scanner`.

### Shared Postgres → PostGIS (once)

`main-postgres` must be **`postgis/postgis:16-3.4`** (not plain `postgres:16`):

```bash
# On VPS: edit ~/postgres/docker-compose.yml image, then:
cd ~/postgres && docker compose up -d
```

Create role/DB:

```bash
docker exec -e PGPASSWORD=… main-postgres \
  psql -U ster -d postgres -c "CREATE USER nca_scanner WITH PASSWORD '…';"
docker exec -e PGPASSWORD=… main-postgres \
  psql -U ster -d postgres -c "CREATE DATABASE nca_scanner OWNER nca_scanner;"
docker exec -e PGPASSWORD=… main-postgres \
  psql -U ster -d nca_scanner -c "CREATE EXTENSION IF NOT EXISTS postgis;"
# grant if needed:
docker exec -e PGPASSWORD=… main-postgres \
  psql -U ster -d nca_scanner -c "ALTER DATABASE nca_scanner OWNER TO nca_scanner;"
```

### App deploy

1. Sync this repo to `~/waze-nca-scanner`, fill `deploy/.env.prod` from `.env.prod.example`.
2. `cd ~/waze-nca-scanner/deploy && chmod +x deploy.sh && ./deploy.sh`
3. Host nginx + Let's Encrypt:

```bash
~/waze-nca-scanner/deploy/install-nginx.sh
```

Compose binds API on **127.0.0.1:8097** only; public access via nginx on 443.

### Data migrate from local

Local DB is ~5 GB (`address_points` + `scan_tiles`). Prefer dump/restore over re-scanning:

```bash
# local
docker exec nca-scanner-db pg_dump -U nca -Fc -f /tmp/nca_scanner.dump nca_scanner
docker cp nca-scanner-db:/tmp/nca_scanner.dump ./nca_scanner.dump
scp -o ProxyJump=… nca_scanner.dump myvps-tunnel:/tmp/

# VPS — stop API, restore, start
cd ~/waze-nca-scanner/deploy && docker compose -f docker-compose.prod.yml --env-file .env.prod stop api
docker cp /tmp/nca_scanner.dump main-postgres:/tmp/nca_scanner.dump
docker exec -e PGPASSWORD=… main-postgres \
  pg_restore -U ster -d nca_scanner --clean --if-exists --no-owner --no-acl /tmp/nca_scanner.dump
# Restore as superuser then re-own app tables (TypeORM migrations need this):
docker exec -e PGPASSWORD=… main-postgres psql -U ster -d nca_scanner -c \
  "ALTER TABLE address_points OWNER TO nca_scanner; ALTER TABLE land_parcels OWNER TO nca_scanner; ALTER TABLE scan_tiles OWNER TO nca_scanner; ALTER TABLE migrations OWNER TO nca_scanner; GRANT ALL ON SCHEMA public TO nca_scanner;"
./deploy.sh
```

## Userscript

Install from this repo (Tampermonkey). Auto-update via `@updateURL` / `@downloadURL` pointing at GitHub `main`. Default API base: `https://waze-nca-scanner.ster.by`. Also mirrored in [`wme-scripts`](https://github.com/ixxvivxxi/wme-scripts).

## License

UNLICENSED / private use.
