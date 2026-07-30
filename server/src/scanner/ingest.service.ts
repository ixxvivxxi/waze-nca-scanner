import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { GeoJsonFeature } from './geojson-types';
import { geometryTo4326GeoJson } from './geom-to-4326';

function scalarToString(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'bigint') return String(v);
  return null;
}

function normalizedStreetKeyFromProps(
  props: Record<string, unknown>,
): string | null {
  const typeRaw = scalarToString(props.element_type_name) ?? '';
  const nameRaw = scalarToString(props.element_name) ?? '';
  const street = `${typeRaw.trim()} ${nameRaw.trim()}`.trim().toLowerCase();
  return street || null;
}

function normalizedHouseKeyFromProps(
  props: Record<string, unknown>,
): string | null {
  const n = scalarToString(props.building_number) ?? '';
  const i = scalarToString(props.building_index) ?? '';
  const house = `${n.trim()}${i.trim()}`.trim().toLowerCase();
  return house || null;
}

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

  private async hasAddressPointByStreetAndHouse(
    streetKey: string,
    houseKey: string,
  ): Promise<boolean> {
    const rows = await this.ds.query<{ exists_row: number }[]>(
      `SELECT 1 AS exists_row
       FROM address_points ap
       WHERE lower(trim(
               concat_ws(' ',
                 nullif(trim(coalesce(ap.properties->>'element_type_name', '')), ''),
                 nullif(trim(coalesce(ap.properties->>'element_name', '')), '')
               )
             )) = $1
         AND lower(trim(
               concat(
                 nullif(trim(coalesce(ap.properties->>'building_number', '')), ''),
                 nullif(trim(coalesce(ap.properties->>'building_index', '')), '')
               )
             )) = $2
       LIMIT 1`,
      [streetKey, houseKey],
    );
    return rows.length > 0;
  }

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

  async upsertParcelFeatures(features: GeoJsonFeature[]): Promise<number> {
    let n = 0;
    for (const f of features) {
      const wfsId = f.id != null ? String(f.id) : '';
      if (!wfsId) continue;
      const props = f.properties ?? {};
      const purposeCode = scalarToString(props.purpose_code)?.trim();
      if (purposeCode !== '19') continue;
      const streetKey = normalizedStreetKeyFromProps(props);
      const houseKey = normalizedHouseKeyFromProps(props);
      if (!streetKey || !houseKey) continue;
      if (await this.hasAddressPointByStreetAndHouse(streetKey, houseKey)) {
        continue;
      }
      const cadNum = scalarToString(props.cad_num);
      const objectId = scalarToString(props.object_id);
      const geomRaw = f.geometry;
      if (
        !geomRaw ||
        (geomRaw.type !== 'Polygon' && geomRaw.type !== 'MultiPolygon')
      )
        continue;
      const geom4326 = geometryTo4326GeoJson(geomRaw);
      const asMulti =
        geom4326.type === 'Polygon'
          ? {
              type: 'MultiPolygon',
              coordinates: [(geom4326 as { coordinates: unknown }).coordinates],
            }
          : geom4326;
      await this.ds.query(
        `INSERT INTO land_parcels (wfs_feature_id, cad_num, object_id, geom, properties, fetched_at)
         VALUES ($1, $2, $3::bigint, ST_Multi(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))), $5::jsonb, now())
         ON CONFLICT (wfs_feature_id) DO UPDATE SET
           cad_num = COALESCE(EXCLUDED.cad_num, land_parcels.cad_num),
           object_id = COALESCE(EXCLUDED.object_id, land_parcels.object_id),
           geom = EXCLUDED.geom,
           properties = EXCLUDED.properties,
           fetched_at = now()`,
        [
          wfsId,
          cadNum,
          objectId,
          JSON.stringify(asMulti),
          JSON.stringify(props),
        ],
      );
      n++;
    }
    return n;
  }
}
