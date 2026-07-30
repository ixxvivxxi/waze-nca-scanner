/**
 * Belarus coverage: a single WGS84 grid over the country envelope; each cell is
 * kept iff it intersects at least one voblast polygon (outer minus holes), then
 * assigned to exactly one oblast so borders do not duplicate work. Assignment
 * uses cell centre when possible; otherwise a stable tie-break (Minsk city
 * before Minsk oblast, then lexicographic id).
 */

import {
  BELARUS_OBLASTS,
  type BelarusOblastDefinition,
} from './belarus-oblast-rings.generated';
import {
  cellIntersectsOblast,
  pointInOblast,
  unionOuterBounds,
} from './belarus-polygon-contains';

export interface RegionBBox {
  id: string;
  nameEn: string;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export interface BelarusRegionTiles {
  readonly id: string;
  readonly nameEn: string;
  /** Grid cells owned by this voblast (see module doc). */
  readonly bboxes: readonly RegionBBox[];
}

/** ~4.5 km E–W at ~54°N; tune if upstream throttles or returns empty cells. */
export const SEED_TILE_STEP_LON = 0.055;
/** ~4.7 km N–S */
export const SEED_TILE_STEP_LAT = 0.042;

function unionEnvelopeAllOblasts(): {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
} {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const o of BELARUS_OBLASTS) {
    const b = unionOuterBounds(o);
    minLon = Math.min(minLon, b.minLon);
    maxLon = Math.max(maxLon, b.maxLon);
    minLat = Math.min(minLat, b.minLat);
    maxLat = Math.max(maxLat, b.maxLat);
  }
  return { minLon, maxLon, minLat, maxLat };
}

/** Stable ownership when a cell touches more than one voblast (shared border). */
function compareOblastOwnership(
  a: BelarusOblastDefinition,
  b: BelarusOblastDefinition,
): number {
  if (a.id === 'minsk_city' && b.id === 'minsk_oblast') return -1;
  if (a.id === 'minsk_oblast' && b.id === 'minsk_city') return 1;
  return a.id.localeCompare(b.id);
}

function pickOwningOblast(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  hits: BelarusOblastDefinition[],
): BelarusOblastDefinition {
  if (hits.length === 1) return hits[0];
  const cx = (minLon + maxLon) / 2;
  const cy = (minLat + maxLat) / 2;
  const withCenter = hits.filter((o) => pointInOblast(cx, cy, o));
  const pool = withCenter.length > 0 ? withCenter : hits;
  return [...pool].sort(compareOblastOwnership)[0];
}

function buildBelarusTileGroups(): BelarusRegionTiles[] {
  const { minLon, maxLon, minLat, maxLat } = unionEnvelopeAllOblasts();
  const stepLon = SEED_TILE_STEP_LON;
  const stepLat = SEED_TILE_STEP_LAT;
  const byOblast = new Map<string, RegionBBox[]>();
  for (const o of BELARUS_OBLASTS) {
    byOblast.set(o.id, []);
  }

  let row = 0;
  for (let lo = minLon; lo < maxLon - 1e-12; lo += stepLon) {
    let col = 0;
    for (let la = minLat; la < maxLat - 1e-12; la += stepLat) {
      const maxLo = Math.min(lo + stepLon, maxLon);
      const maxLa = Math.min(la + stepLat, maxLat);
      const hits = BELARUS_OBLASTS.filter((o) =>
        cellIntersectsOblast(lo, la, maxLo, maxLa, o),
      );
      if (hits.length > 0) {
        const owner = pickOwningOblast(lo, la, maxLo, maxLa, hits);
        byOblast.get(owner.id)!.push({
          id: `${owner.id}_${row}_${col}`,
          nameEn: owner.nameEn,
          minLon: lo,
          minLat: la,
          maxLon: maxLo,
          maxLat: maxLa,
        });
      }
      col++;
    }
    row++;
  }

  return BELARUS_OBLASTS.map((o) => ({
    id: o.id,
    nameEn: o.nameEn,
    bboxes: byOblast.get(o.id) ?? [],
  }));
}

/** One entry per voblast / Minsk city; tiles partition the covered land (one owner per cell). */
export const BELARUS_TILE_GROUPS: readonly BelarusRegionTiles[] =
  buildBelarusTileGroups();

/** Flattened list (same tiles as in {@link BELARUS_TILE_GROUPS}). */
export const BELARUS_COVERAGE_BOXES: readonly RegionBBox[] =
  BELARUS_TILE_GROUPS.flatMap((g) => g.bboxes);
