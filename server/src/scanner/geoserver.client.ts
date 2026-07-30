import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import type { GeoJsonFeatureCollection } from './geojson-types';

/** Live viewer tries these in order until the first non-null HTTP response. */
export type WfsGetFeatureStrategy = 'wfs20-wgs84' | 'wfs11-wgs84' | 'wfs20-3857';

export interface WfsBboxPageParams {
  typeNames: string;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  /** Required for strategy `wfs20-3857`. */
  bbox3857?: { minX: number; minY: number; maxX: number; maxY: number };
  /**
   * Page size. Omit (or 0) to request without COUNT — avoids GeoServer
   * "Cannot do natural order without a primary key" on some layers.
   */
  count?: number;
  /** Omit when 0 so STARTINDEX is not sent (same server bug). */
  startIndex?: number;
}

function normalizeWgs84Extent(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): { minLo: number; maxLo: number; minLa: number; maxLa: number } {
  return {
    minLo: Math.min(minLon, maxLon),
    maxLo: Math.max(minLon, maxLon),
    minLa: Math.min(minLat, maxLat),
    maxLa: Math.max(minLat, maxLat),
  };
}

/** GeoServer NCA WFS fails paging without PK — only send COUNT / STARTINDEX when needed. */
function wfsPagingKvp(
  p: WfsBboxPageParams,
  mode: 'wfs2' | 'wfs11',
): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {};
  const c = p.count;
  if (c != null && c > 0) {
    if (mode === 'wfs2') out.count = c;
    else out.maxFeatures = c;
  }
  const s = p.startIndex;
  if (s != null && s > 0) out.startIndex = s;
  return out;
}

@Injectable()
export class GeoserverClient {
  private readonly log = new Logger(GeoserverClient.name);

  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async delayBetweenRequests(): Promise<void> {
    const ms = Number(this.config.get('requestDelayMs') ?? 400);
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  /**
   * WFS base URL: optional geoserverWfsBase, else same as geoserverBase (…/ows).
   * map.nca.by serves WFS on `/ows`; a bare `/wfs` URL can reset the connection here.
   */
  getWfsUrl(): string {
    const explicit = String(this.config.get('geoserverWfsBase') ?? '').trim();
    if (explicit !== '') return explicit.replace(/\/+$/, '');
    return String(
      this.config.get('geoserverBase') ??
        'https://map.nca.by/geoserver/pcm/ows',
    ).replace(/\/+$/, '');
  }

  /**
   * WMS 1.3.0 GetFeatureInfo → GeoJSON FeatureCollection (works for address + parcel layers on map.nca.by).
   */
  async getFeatureInfoJson(params: {
    layer: string;
    bbox3857: string;
    width: number;
    height: number;
    i: number;
    j: number;
    featureCount: number;
    /** WMS STYLES (e.g. pcm:…_text on map.nca.by); omit when empty. */
    styles?: string;
  }): Promise<GeoJsonFeatureCollection> {
    const base = String(
      this.config.get('geoserverBase') ??
        'https://map.nca.by/geoserver/pcm/ows',
    );
    const referer = String(
      this.config.get('geoserverReferer') ?? 'https://map.nca.by/',
    );
    const timeout = Number(this.config.get('httpTimeoutMs') ?? 45_000);
    const query: Record<string, string | number> = {
      SERVICE: 'WMS',
      VERSION: '1.3.0',
      REQUEST: 'GetFeatureInfo',
      LAYERS: params.layer,
      QUERY_LAYERS: params.layer,
      INFO_FORMAT: 'application/json',
      CRS: 'EPSG:3857',
      BBOX: params.bbox3857,
      WIDTH: params.width,
      HEIGHT: params.height,
      I: params.i,
      J: params.j,
      FEATURE_COUNT: params.featureCount,
    };
    const st = params.styles?.trim();
    if (st) {
      query.STYLES = st;
    }
    const { data, status } = await firstValueFrom(
      this.http.get<GeoJsonFeatureCollection | string>(base, {
        params: query,
        timeout,
        headers: {
          Referer: referer,
          'User-Agent': 'nca-scanner/1.0 (local; WFS/WMS consumer)',
        },
        validateStatus: () => true,
      }),
    );
    if (status !== 200 || typeof data === 'string') {
      const preview =
        typeof data === 'string' ? data.slice(0, 400).replace(/\s+/g, ' ') : '';
      this.log.warn(
        `GetFeatureInfo status=${status} layer=${params.layer} ${params.width}x${params.height} I=${params.i} J=${params.j}${preview ? ` body=${preview}` : ''}`,
      );
      return { type: 'FeatureCollection', features: [] };
    }
    return data;
  }

  /**
   * WFS GetFeature KVP (uppercase keys, same style as working WMS requests on map.nca.by).
   */
  private async wfsKvpGet(
    query: Record<string, string | number | undefined>,
  ): Promise<GeoJsonFeatureCollection | null> {
    const base = this.getWfsUrl();
    const referer = String(
      this.config.get('geoserverReferer') ?? 'https://map.nca.by/',
    );
    const timeout = Number(this.config.get('httpTimeoutMs') ?? 45_000);
    const params: Record<string, string | number> = {
      SERVICE: 'WFS',
      REQUEST: 'GetFeature',
      OUTPUTFORMAT: 'application/json',
    };
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      params[k.toUpperCase()] = v;
    }
    let data: GeoJsonFeatureCollection | string | undefined;
    let status: number;
    const headers = {
      Referer: referer,
      'User-Agent': 'nca-scanner/1.0 (local; WFS/WMS consumer)',
    };
    try {
      const res = await firstValueFrom(
        this.http.get<GeoJsonFeatureCollection | string>(base, {
          params,
          timeout,
          headers,
          validateStatus: () => true,
        }),
      );
      data = res.data;
      status = res.status;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(
        `WFS GetFeature GET transport error, retrying POST url=${base} ${msg}`,
      );
      try {
        const body = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
          body.set(k, String(v));
        }
        const res = await firstValueFrom(
          this.http.post<GeoJsonFeatureCollection | string>(
            base,
            body.toString(),
            {
              timeout,
              headers: {
                ...headers,
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              validateStatus: () => true,
            },
          ),
        );
        data = res.data;
        status = res.status;
      } catch (e2) {
        const msg2 = e2 instanceof Error ? e2.message : String(e2);
        this.log.warn(`WFS GetFeature POST transport error url=${base} ${msg2}`);
        return null;
      }
    }
    if (status !== 200 || typeof data === 'string') {
      const preview =
        typeof data === 'string'
          ? data.slice(0, 500).replace(/\s+/g, ' ')
          : '';
      this.log.warn(
        `WFS GetFeature url=${base} status=${status}${preview ? ` body=${preview}` : ''}`,
      );
      return null;
    }
    if (
      !data ||
      typeof data !== 'object' ||
      (data as GeoJsonFeatureCollection).type !== 'FeatureCollection' ||
      !Array.isArray((data as GeoJsonFeatureCollection).features)
    ) {
      this.log.warn(`WFS GetFeature returned unexpected JSON shape`);
      return null;
    }
    return data as GeoJsonFeatureCollection;
  }

  /**
   * One WFS GetFeature page for viewer live NCA (bbox filter + paging).
   */
  async wfsGetFeaturePage(
    strategy: WfsGetFeatureStrategy,
    p: WfsBboxPageParams,
  ): Promise<GeoJsonFeatureCollection | null> {
    if (strategy === 'wfs20-3857') {
      const b = p.bbox3857;
      if (!b) return null;
      const bbox3857 = `${b.minX},${b.minY},${b.maxX},${b.maxY},EPSG:3857`;
      return this.wfsKvpGet({
        VERSION: '2.0.0',
        typenames: p.typeNames,
        bbox: bbox3857,
        srsName: 'EPSG:3857',
        ...wfsPagingKvp(p, 'wfs2'),
      });
    }

    const { minLo, maxLo, minLa, maxLa } = normalizeWgs84Extent(
      p.minLon,
      p.minLat,
      p.maxLon,
      p.maxLat,
    );
    const bbox4326 = `${minLo},${minLa},${maxLo},${maxLa},EPSG:4326`;

    if (strategy === 'wfs20-wgs84') {
      return this.wfsKvpGet({
        VERSION: '2.0.0',
        typenames: p.typeNames,
        bbox: bbox4326,
        srsName: 'EPSG:3857',
        ...wfsPagingKvp(p, 'wfs2'),
      });
    }

    if (strategy === 'wfs11-wgs84') {
      return this.wfsKvpGet({
        VERSION: '1.1.0',
        typename: p.typeNames,
        bbox: bbox4326,
        srsName: 'EPSG:3857',
        ...wfsPagingKvp(p, 'wfs11'),
      });
    }

    return null;
  }

  /**
   * WFS GetFeature by feature id or CQL (optional backfill).
   * @deprecated Prefer {@link wfsGetFeaturePage} for bbox queries.
   */
  async wfsGetFeatureJson(
    query: Record<string, string | number | undefined>,
  ): Promise<GeoJsonFeatureCollection | null> {
    return this.wfsKvpGet({
      VERSION: '2.0.0',
      ...query,
    });
  }

  /**
   * WFS 2.0 GetFeature constrained by EPSG:3857 bbox (returns full features, not pixel samples).
   */
  async wfsGetFeatureByBbox3857(params: {
    typeNames: string;
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    count?: number;
    startIndex?: number;
  }): Promise<GeoJsonFeatureCollection | null> {
    const bbox3857 = `${params.minX},${params.minY},${params.maxX},${params.maxY},EPSG:3857`;
    return this.wfsKvpGet({
      VERSION: '2.0.0',
      typenames: params.typeNames,
      bbox: bbox3857,
      srsName: 'EPSG:3857',
      ...wfsPagingKvp(
        {
          typeNames: params.typeNames,
          minLon: 0,
          minLat: 0,
          maxLon: 0,
          maxLat: 0,
          count: params.count,
          startIndex: params.startIndex,
        },
        'wfs2',
      ),
    });
  }
}
