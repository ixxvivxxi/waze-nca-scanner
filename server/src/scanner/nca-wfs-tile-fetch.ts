import { lonLatTileToBbox3857 } from './bbox-3857';
import type { GeoJsonFeature } from './geojson-types';
import type { GeoJsonFeatureCollection } from './geojson-types';
import {
  GeoserverClient,
  type WfsGetFeatureStrategy,
} from './geoserver.client';

const WFS_STRATEGIES: WfsGetFeatureStrategy[] = [
  'wfs20-wgs84',
  'wfs11-wgs84',
  'wfs20-3857',
];

export type NcaWfsTileLayerKind = 'addresses' | 'parcels';

function stringifyProp(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint') {
    return String(v);
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return '';
}

function dedupeKey(layerKind: NcaWfsTileLayerKind, f: GeoJsonFeature): string {
  const p = f.properties ?? {};
  if (layerKind === 'addresses') {
    const ida = stringifyProp(p.id_adr);
    if (ida !== '') return `a:${ida}`;
    if (f.id != null) return `a:id:${String(f.id)}`;
    return `a:${JSON.stringify(p).slice(0, 120)}`;
  }
  if (f.id != null) return `p:${String(f.id)}`;
  const oid = stringifyProp(p.object_id);
  if (oid !== '') return `p:o:${oid}`;
  return `p:${JSON.stringify(p).slice(0, 120)}`;
}

/** WGS84 sub-rectangle sx,sy in [0, parts)² covering [minX,maxX]×[minY,maxY]. */
function subBboxWgs84(
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  parts: number,
  sx: number,
  sy: number,
): { minLon: number; minLat: number; maxLon: number; maxLat: number } {
  const w = maxX - minX;
  const h = maxY - minY;
  const minLon = minX + (sx / parts) * w;
  const maxLon = minX + ((sx + 1) / parts) * w;
  const minLat = minY + (sy / parts) * h;
  const maxLat = minY + ((sy + 1) / parts) * h;
  return { minLon, minLat, maxLon, maxLat };
}

/** Prefix from WMS layer (e.g. pcm:) + typename without workspace. */
export function qualifiedWfsTypeNames(
  wmsLayer: string,
  wfsTypename: string,
): string {
  const wms = String(wmsLayer ?? '').trim();
  const wfs = String(wfsTypename ?? '').trim();
  if (wfs.includes(':')) return wfs;
  const colon = wms.indexOf(':');
  const prefix = colon >= 0 ? wms.slice(0, colon + 1) : 'pcm:';
  return prefix + wfs;
}

/**
 * WFS GetFeature per sub-cell (same strategies as viewer live NCA).
 * map.nca.by WMS GetFeatureInfo often returns empty GeoJSON for these layers; WFS is reliable.
 */
export async function fetchNcaWfsFeaturesForLonLatBBox(opts: {
  geo: GeoserverClient;
  typeNames: string;
  layerKind: NcaWfsTileLayerKind;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  subdiv: number;
  delayMs: number;
  warn?: (msg: string) => void;
}): Promise<GeoJsonFeature[]> {
  const minX = Math.min(opts.minLon, opts.maxLon);
  const maxX = Math.max(opts.minLon, opts.maxLon);
  const minY = Math.min(opts.minLat, opts.maxLat);
  const maxY = Math.max(opts.minLat, opts.maxLat);
  const subdiv = Math.max(1, Math.min(12, Math.floor(opts.subdiv)));
  const delayMs = Math.max(0, opts.delayMs);

  const merged: GeoJsonFeature[] = [];
  const seen = new Set<string>();

  for (let sx = 0; sx < subdiv; sx++) {
    for (let sy = 0; sy < subdiv; sy++) {
      if (delayMs > 0) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      const sub = subBboxWgs84(minX, minY, maxX, maxY, subdiv, sx, sy);
      const bbox3857Str = lonLatTileToBbox3857(
        sub.minLon,
        sub.minLat,
        sub.maxLon,
        sub.maxLat,
      );
      const parts = bbox3857Str.split(',').map(Number);
      let bbox3857:
        | { minX: number; minY: number; maxX: number; maxY: number }
        | undefined;
      if (
        parts.length === 4 &&
        parts.every((n) => Number.isFinite(n)) &&
        parts[0] != null &&
        parts[1] != null &&
        parts[2] != null &&
        parts[3] != null
      ) {
        bbox3857 = {
          minX: parts[0],
          minY: parts[1],
          maxX: parts[2],
          maxY: parts[3],
        };
      }

      const last = WFS_STRATEGIES[WFS_STRATEGIES.length - 1];
      let fc: GeoJsonFeatureCollection | null = null;

      try {
        for (const strat of WFS_STRATEGIES) {
          fc = await opts.geo.wfsGetFeaturePage(strat, {
            typeNames: opts.typeNames,
            minLon: sub.minLon,
            minLat: sub.minLat,
            maxLon: sub.maxLon,
            maxLat: sub.maxLat,
            bbox3857,
          });
          if (fc == null) continue;
          if (fc.features.length > 0 || strat === last) break;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        opts.warn?.(`WFS GetFeature sub ${sx},${sy}: ${msg}`);
        continue;
      }

      if (fc == null) {
        opts.warn?.(
          `WFS GetFeature all strategies failed sub=${sx},${sy} typeNames=${opts.typeNames} wfsUrl=${opts.geo.getWfsUrl()}`,
        );
        continue;
      }

      for (const f of fc.features) {
        const k = dedupeKey(opts.layerKind, f);
        if (seen.has(k)) continue;
        seen.add(k);
        merged.push(f);
      }
    }
  }

  return merged;
}
