import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

export interface NearbyAddressRow {
  idAdr: string;
  lon: number;
  lat: number;
  properties: Record<string, unknown>;
  distanceM: number;
}

@Injectable()
export class AddressesNearbyService {
  constructor(@InjectDataSource() private readonly ds: DataSource) {}

  async findNearby(
    lon: number,
    lat: number,
    radiusM: number,
    limit: number,
  ): Promise<NearbyAddressRow[]> {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new BadRequestException('Invalid lon or lat');
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      throw new BadRequestException('lon/lat out of range');
    }
    if (radiusM < 10 || radiusM > 10_000) {
      throw new BadRequestException('radiusM must be between 10 and 10000');
    }
    if (limit < 1 || limit > 100) {
      throw new BadRequestException('limit must be between 1 and 100');
    }

    const rows = await this.ds.query<
      {
        id_adr: string;
        lon: number;
        lat: number;
        properties: Record<string, unknown>;
        distance_m: string;
      }[]
    >(
      `WITH req AS (
         SELECT ST_SetSRID(ST_MakePoint($1::float8, $2::float8), 4326)::geography AS p
       )
       SELECT
         a.id_adr::text AS id_adr,
         ST_X(a.geom::geometry)::float8 AS lon,
         ST_Y(a.geom::geometry)::float8 AS lat,
         a.properties,
         ST_Distance(a.geom::geography, req.p)::float8 AS distance_m
       FROM address_points a, req
       WHERE ST_DWithin(a.geom::geography, req.p, $3::float8)
       ORDER BY distance_m ASC
       LIMIT $4::int`,
      [lon, lat, radiusM, limit],
    );

    return rows.map((r) => ({
      idAdr: String(r.id_adr),
      lon: Number(r.lon),
      lat: Number(r.lat),
      properties:
        r.properties && typeof r.properties === 'object' ? r.properties : {},
      distanceM: Number(r.distance_m),
    }));
  }

  /** Max side length in degrees (prevents huge table scans if the client sends a world bbox). */
  private static readonly BBOX_MAX_SPAN_DEG = 0.35;

  /** Hard cap on rows returned for bbox (not exposed as a query parameter). */
  private static readonly BBOX_QUERY_HARD_CAP = 250_000;

  async findInBbox(
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
  ): Promise<NearbyAddressRow[]> {
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
    const cap = AddressesNearbyService.BBOX_MAX_SPAN_DEG;
    if (dLon > cap || dLat > cap) {
      throw new BadRequestException(
        `bbox side must be at most ${cap}° (zoom in or narrow the view)`,
      );
    }

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const rows = await this.ds.query<
      {
        id_adr: string;
        lon: number;
        lat: number;
        properties: Record<string, unknown>;
        distance_m: string;
      }[]
    >(
      `WITH env AS (
         SELECT ST_MakeEnvelope($1::float8, $2::float8, $3::float8, $4::float8, 4326) AS e
       ),
       ctr AS (
         SELECT ST_SetSRID(ST_MakePoint($5::float8, $6::float8), 4326)::geography AS p
       )
       SELECT
         a.id_adr::text AS id_adr,
         ST_X(a.geom::geometry)::float8 AS lon,
         ST_Y(a.geom::geometry)::float8 AS lat,
         a.properties,
         ST_Distance(a.geom::geography, ctr.p)::float8 AS distance_m
       FROM address_points a, env, ctr
       WHERE a.geom && env.e
         AND ST_Intersects(a.geom::geometry, env.e)
       ORDER BY distance_m ASC
       LIMIT $7::int`,
      [
        minX,
        minY,
        maxX,
        maxY,
        cx,
        cy,
        AddressesNearbyService.BBOX_QUERY_HARD_CAP,
      ],
    );

    return rows.map((r) => ({
      idAdr: String(r.id_adr),
      lon: Number(r.lon),
      lat: Number(r.lat),
      properties:
        r.properties && typeof r.properties === 'object' ? r.properties : {},
      distanceM: Number(r.distance_m),
    }));
  }
}
