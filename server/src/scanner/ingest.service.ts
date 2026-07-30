import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { GeoJsonFeature } from './geojson-types';
import { geometryTo4326GeoJson } from './geom-to-4326';

/** NCA WFS may use different property casings or only GeoJSON `id`. */
function resolveAddressIdAdr(f: GeoJsonFeature): string | null {
  const p = f.properties as Record<string, unknown> | undefined;
  if (p) {
    for (const k of ['id_adr', 'ID_ADR', 'Id_Adr', 'idAdr']) {
      const v = p[k];
      if (v == null) continue;
      if (typeof v === 'bigint') return String(v);
      if (typeof v === 'number' && Number.isFinite(v)) return String(Math.trunc(v));
      const s = String(v).trim().replace(/\s/g, '');
      if (s && s !== 'NaN') return s;
    }
  }
  if (f.id != null) {
    const sid = String(f.id);
    const m = sid.match(/(\d{4,})$/);
    if (m) return m[1];
    if (/^\d+$/.test(sid)) return sid;
  }
  return null;
}

function extractAddressPointGeometry(
  f: GeoJsonFeature,
): { type: 'Point'; coordinates: [number, number] } | null {
  const g = f.geometry;
  if (!g || typeof g !== 'object') return null;
  if (
    g.type === 'Point' &&
    Array.isArray(g.coordinates) &&
    (g.coordinates as number[]).length >= 2
  ) {
    const c = g.coordinates as number[];
    return { type: 'Point', coordinates: [c[0], c[1]] };
  }
  if (
    g.type === 'MultiPoint' &&
    Array.isArray(g.coordinates) &&
    (g.coordinates as number[][]).length > 0
  ) {
    const c0 = (g.coordinates as number[][])[0];
    if (c0 && c0.length >= 2) {
      return { type: 'Point', coordinates: [c0[0], c0[1]] };
    }
  }
  return null;
}

@Injectable()
export class IngestService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async upsertAddressFeatures(features: GeoJsonFeature[]): Promise<number> {
    let n = 0;
    for (const f of features) {
      const props = f.properties ?? {};
      const idAdr = resolveAddressIdAdr(f);
      if (!idAdr) continue;
      const pt = extractAddressPointGeometry(f);
      if (!pt) continue;
      const geom4326 = geometryTo4326GeoJson(pt);
      const wfsId = f.id != null ? String(f.id) : null;
      await this.ds.query(
        `INSERT INTO address_points (id_adr, geom, properties, wfs_feature_id, fetched_at)
         VALUES ($1::bigint, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), $3::jsonb, $4, now())
         ON CONFLICT (id_adr) DO UPDATE SET
           geom = EXCLUDED.geom,
           properties = EXCLUDED.properties,
           wfs_feature_id = COALESCE(EXCLUDED.wfs_feature_id, address_points.wfs_feature_id),
           fetched_at = now()`,
        [idAdr, JSON.stringify(geom4326), JSON.stringify(props), wfsId],
      );
      n++;
    }
    return n;
  }
}
