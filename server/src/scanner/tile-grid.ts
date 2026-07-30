import { createHash } from 'crypto';
import type { ScanLayerKind } from './entities/scan-tile.entity';

export interface LonLatTile {
  regionId: string;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  depth: number;
  parentTileKey: string | null;
}

export function quadSplit(
  layerKind: ScanLayerKind,
  tile: LonLatTile,
): LonLatTile[] {
  const midLon = (tile.minLon + tile.maxLon) / 2;
  const midLat = (tile.minLat + tile.maxLat) / 2;
  const d = tile.depth + 1;
  const parent = makeTileKey(layerKind, tile);
  return [
    {
      regionId: tile.regionId,
      minLon: tile.minLon,
      minLat: tile.minLat,
      maxLon: midLon,
      maxLat: midLat,
      depth: d,
      parentTileKey: parent,
    },
    {
      regionId: tile.regionId,
      minLon: midLon,
      minLat: tile.minLat,
      maxLon: tile.maxLon,
      maxLat: midLat,
      depth: d,
      parentTileKey: parent,
    },
    {
      regionId: tile.regionId,
      minLon: tile.minLon,
      minLat: midLat,
      maxLon: midLon,
      maxLat: tile.maxLat,
      depth: d,
      parentTileKey: parent,
    },
    {
      regionId: tile.regionId,
      minLon: midLon,
      minLat: midLat,
      maxLon: tile.maxLon,
      maxLat: tile.maxLat,
      depth: d,
      parentTileKey: parent,
    },
  ];
}

export function makeTileKey(layerKind: ScanLayerKind, t: LonLatTile): string {
  const payload = [
    layerKind,
    t.regionId,
    t.depth,
    t.minLon.toFixed(6),
    t.minLat.toFixed(6),
    t.maxLon.toFixed(6),
    t.maxLat.toFixed(6),
  ].join('|');
  return createHash('sha256').update(payload).digest('hex');
}
