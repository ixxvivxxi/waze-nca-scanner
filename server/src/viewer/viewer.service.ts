import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ScannerService, type ScannerActiveTile } from '../scanner/scanner.service';

/** Minimal GeoJSON shape returned from PostGIS json_build_object. */
export type ViewerFeatureCollection = {
  type: 'FeatureCollection';
  features: unknown[];
};

export interface ViewerStats {
  addressCount: number;
  scanTiles: {
    total: number;
    done: number;
    pending: number;
    failed: number;
    byLayer: { layerKind: string; status: string; count: number }[];
  };
  /** Background scanner: bbox currently being fetched from NCA (null if idle). */
  activeScan: ScannerActiveTile | null;
}

/**
 * Wider than the public `/api/addresses/bbox` cap: the viewer is for map overview
 * (e.g. full Belarus ~12° wide) while row limits keep queries bounded.
 */
const VIEWER_BBOX_MAX_SPAN_DEG = 15;

const DEFAULT_LIMITS = {
  scanTiles: 50_000,
  addresses: 8_000,
} as const;

function parseBbox(
  minLonStr: string,
  minLatStr: string,
  maxLonStr: string,
  maxLatStr: string,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const minLon = Number(minLonStr);
  const minLat = Number(minLatStr);
  const maxLon = Number(maxLonStr);
  const maxLat = Number(maxLatStr);
  if (
    !Number.isFinite(minLon) ||
    !Number.isFinite(minLat) ||
    !Number.isFinite(maxLon) ||
    !Number.isFinite(maxLat)
  ) {
    throw new BadRequestException('Invalid bbox coordinates');
  }
  const minX = Math.min(minLon, maxLon);
  const maxX = Math.max(minLon, maxLon);
  const minY = Math.min(minLat, maxLat);
  const maxY = Math.max(minLat, maxLat);
  if (minX < -180 || maxX > 180 || minY < -90 || maxY > 90) {
    throw new BadRequestException('bbox out of WGS84 range');
  }
  const dLon = maxX - minX;
  const dLat = maxY - minY;
  if (dLon <= 0 || dLat <= 0) {
    throw new BadRequestException('bbox must have positive width and height');
  }
  if (dLon > VIEWER_BBOX_MAX_SPAN_DEG || dLat > VIEWER_BBOX_MAX_SPAN_DEG) {
    throw new BadRequestException(
      `bbox side must be at most ${VIEWER_BBOX_MAX_SPAN_DEG}° (zoom in)`,
    );
  }
  return { minX, minY, maxX, maxY };
}

function parseLimit(
  limitStr: string | undefined,
  fallback: number,
  max: number,
): number {
  if (limitStr == null || limitStr === '') return fallback;
  const n = Number(limitStr);
  if (!Number.isFinite(n) || n < 1) {
    throw new BadRequestException('limit must be a positive number');
  }
  return Math.min(Math.floor(n), max);
}

@Injectable()
export class ViewerService {
  constructor(
    @InjectDataSource() private readonly ds: DataSource,
    private readonly scanner: ScannerService,
  ) {}

  async getStats(): Promise<ViewerStats> {
    const [counts] = await this.ds.query<
      {
        address_count: string;
        scan_total: string;
        scan_done: string;
        scan_pending: string;
        scan_failed: string;
      }[]
    >(
      `SELECT
         (SELECT COUNT(*) FROM address_points)::text AS address_count,
         (SELECT COUNT(*) FROM scan_tiles)::text AS scan_total,
         (SELECT COUNT(*) FROM scan_tiles WHERE status = 'done')::text AS scan_done,
         (SELECT COUNT(*) FROM scan_tiles WHERE status = 'pending')::text AS scan_pending,
         (SELECT COUNT(*) FROM scan_tiles WHERE status = 'failed')::text AS scan_failed`,
    );

    const byLayer = await this.ds.query<
      { layer_kind: string; status: string; count: string }[]
    >(
      `SELECT layer_kind, status, COUNT(*)::text AS count
       FROM scan_tiles
       GROUP BY layer_kind, status
       ORDER BY layer_kind, status`,
    );

    return {
      addressCount: Number(counts.address_count),
      scanTiles: {
        total: Number(counts.scan_total),
        done: Number(counts.scan_done),
        pending: Number(counts.scan_pending),
        failed: Number(counts.scan_failed),
        byLayer: byLayer.map((r) => ({
          layerKind: r.layer_kind,
          status: r.status,
          count: Number(r.count),
        })),
      },
      activeScan: this.scanner.getActiveScanTile(),
    };
  }

  /** Frequent poller for /viewer map — avoids stale activeScan bundled with stats (2.5s). */
  getScanActive(): { activeScan: ScannerActiveTile | null } {
    return { activeScan: this.scanner.getActiveScanTile() };
  }

  async getScanTilesGeoJson(
    minLonStr: string,
    minLatStr: string,
    maxLonStr: string,
    maxLatStr: string,
    layerKind: string | undefined,
    limitStr: string | undefined,
  ): Promise<ViewerFeatureCollection> {
    const { minX, minY, maxX, maxY } = parseBbox(
      minLonStr,
      minLatStr,
      maxLonStr,
      maxLatStr,
    );
    const limit = parseLimit(
      limitStr,
      DEFAULT_LIMITS.scanTiles,
      DEFAULT_LIMITS.scanTiles,
    );

    const layerFilter = layerKind === 'addresses' ? layerKind : null;

    const [row] = await this.ds.query<{ geojson: ViewerFeatureCollection }[]>(
      `SELECT json_build_object(
         'type', 'FeatureCollection',
         'features', COALESCE(json_agg(feature ORDER BY tile_key), '[]'::json)
       )::json AS geojson
       FROM (
         SELECT json_build_object(
           'type', 'Feature',
           'geometry', ST_AsGeoJSON(
             ST_MakeEnvelope(st.min_lon, st.min_lat, st.max_lon, st.max_lat, 4326)
           )::json,
           'properties', json_build_object(
             'tileKey', st.tile_key,
             'status', st.status,
             'layerKind', st.layer_kind,
             'regionId', st.region_id,
             'minLon', st.min_lon,
             'minLat', st.min_lat,
             'maxLon', st.max_lon,
             'maxLat', st.max_lat,
             'depth', st.depth,
             'retryCount', st.retry_count,
             'lastError', st.last_error,
             'lastDataFetchedAt', (
               SELECT MAX(ap.fetched_at) FROM address_points ap
               WHERE ap.geom && ST_MakeEnvelope(
                 st.min_lon, st.min_lat, st.max_lon, st.max_lat, 4326
               )
                 AND ST_Intersects(
                   ap.geom::geometry,
                   ST_MakeEnvelope(
                     st.min_lon, st.min_lat, st.max_lon, st.max_lat, 4326
                   )
                 )
             )
           )
         ) AS feature,
         st.tile_key
         FROM scan_tiles st
         WHERE st.max_lon >= $1::float8 AND st.min_lon <= $2::float8
           AND st.max_lat >= $3::float8 AND st.min_lat <= $4::float8
           AND ($5::text IS NULL OR st.layer_kind = $5)
         LIMIT $6::int
       ) sub`,
      [minX, maxX, minY, maxY, layerFilter, limit],
    );

    return row?.geojson ?? { type: 'FeatureCollection', features: [] };
  }

  async getAddressesGeoJson(
    minLonStr: string,
    minLatStr: string,
    maxLonStr: string,
    maxLatStr: string,
    limitStr: string | undefined,
  ): Promise<ViewerFeatureCollection> {
    const { minX, minY, maxX, maxY } = parseBbox(
      minLonStr,
      minLatStr,
      maxLonStr,
      maxLatStr,
    );
    const limit = parseLimit(
      limitStr,
      DEFAULT_LIMITS.addresses,
      DEFAULT_LIMITS.addresses,
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const [row] = await this.ds.query<{ geojson: ViewerFeatureCollection }[]>(
      `SELECT json_build_object(
         'type', 'FeatureCollection',
         'features', COALESCE(json_agg(feature), '[]'::json)
       )::json AS geojson
       FROM (
         SELECT json_build_object(
           'type', 'Feature',
           'geometry', ST_AsGeoJSON(geom)::json,
           'properties', json_build_object(
             'idAdr', id_adr::text,
             'properties', properties
           )
         ) AS feature
         FROM address_points
         WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
           AND ST_Intersects(geom::geometry, ST_MakeEnvelope($1, $2, $3, $4, 4326))
         ORDER BY geom::geometry <-> ST_SetSRID(ST_MakePoint($5, $6), 4326)
         LIMIT $7::int
       ) sub`,
      [minX, minY, maxX, maxY, cx, cy, limit],
    );

    return row?.geojson ?? { type: 'FeatureCollection', features: [] };
  }
}
