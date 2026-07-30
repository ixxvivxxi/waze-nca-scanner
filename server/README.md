# Local development

See the [root README](../README.md) for production and userscript notes.

```bash
cp .env.example .env
docker compose up -d
npm install
npm run migration:run
npm run start:dev
```

- PostGIS: `localhost:5433` (user/db `nca` / `nca_scanner`)
- API: `http://127.0.0.1:3000`
- Scanner: WFS to map.nca.by (requires `GEOSERVER_REFERER`)
