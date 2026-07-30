import type {
  BelarusOblastDefinition,
  LonLat,
  OblastPolygonPiece,
} from './belarus-oblast-rings.generated';

function ringVertexCount(ring: readonly LonLat[]): number {
  const n = ring.length;
  if (n < 3) return n;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[n - 1];
  if (fx === lx && fy === ly) return n - 1;
  return n;
}

/** Ray casting; ring may be closed (first == last). lon, lat in WGS84. */
export function pointInLonLatRing(
  lon: number,
  lat: number,
  ring: readonly LonLat[],
): boolean {
  const nv = ringVertexCount(ring);
  if (nv < 3) return false;
  let inside = false;
  for (let i = 0, j = nv - 1; i < nv; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > lat !== yj > lat) {
      const denom = yj - yi;
      if (Math.abs(denom) < 1e-18) continue;
      const xinters = ((xj - xi) * (lat - yi)) / denom + xi;
      if (lon < xinters) inside = !inside;
    }
  }
  return inside;
}

export function pointInPiece(
  lon: number,
  lat: number,
  piece: OblastPolygonPiece,
): boolean {
  if (!pointInLonLatRing(lon, lat, piece.outer)) return false;
  for (const h of piece.holes) {
    if (pointInLonLatRing(lon, lat, h)) return false;
  }
  return true;
}

export function pointInOblast(
  lon: number,
  lat: number,
  oblast: BelarusOblastDefinition,
): boolean {
  for (const piece of oblast.pieces) {
    if (pointInPiece(lon, lat, piece)) return true;
  }
  return false;
}

function lonLatInClosedRect(
  lon: number,
  lat: number,
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): boolean {
  return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
}

/** Liang–Barsky: segment [P0,P1] intersects closed axis-aligned box (non-degenerate). */
function segmentIntersectsClosedRect(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const rx0 = Math.min(minX, maxX);
  const rx1 = Math.max(minX, maxX);
  const ry0 = Math.min(minY, maxY);
  const ry1 = Math.max(minY, maxY);

  if (
    lonLatInClosedRect(x0, y0, rx0, ry0, rx1, ry1) ||
    lonLatInClosedRect(x1, y1, rx0, ry0, rx1, ry1)
  ) {
    return true;
  }

  let u1 = 0;
  let u2 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - rx0, rx1 - x0, y0 - ry0, ry1 - y0];

  for (let k = 0; k < 4; k++) {
    if (Math.abs(p[k]) < 1e-18) {
      if (q[k] < 0) return false;
      continue;
    }
    const r = q[k] / p[k];
    if (p[k] < 0) {
      if (r > u2) return false;
      if (r > u1) u1 = r;
    } else {
      if (r < u1) return false;
      if (r < u2) u2 = r;
    }
  }
  return u1 <= u2;
}

const CELL_SAMPLE_STEPS = 7;

/**
 * True iff the closed lon/lat rectangle shares any point with oblast land
 * (outer rings minus holes). Uses dense interior sampling plus outer boundary
 * vs rectangle so narrow strips along borders are not dropped.
 */
export function cellIntersectsOblast(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  oblast: BelarusOblastDefinition,
): boolean {
  for (const piece of oblast.pieces) {
    if (cellIntersectsPiece(minLon, minLat, maxLon, maxLat, piece)) {
      return true;
    }
  }
  return false;
}

function cellIntersectsPiece(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
  piece: OblastPolygonPiece,
): boolean {
  const spanLon = maxLon - minLon;
  const spanLat = maxLat - minLat;
  const steps = CELL_SAMPLE_STEPS;
  const denom = steps - 1;
  for (let i = 0; i < steps; i++) {
    const tx = i / denom;
    for (let j = 0; j < steps; j++) {
      const ty = j / denom;
      const lon = minLon + tx * spanLon;
      const lat = minLat + ty * spanLat;
      if (pointInPiece(lon, lat, piece)) return true;
    }
  }

  const nv = ringVertexCount(piece.outer);
  for (let i = 0; i < nv; i++) {
    const [lon, lat] = piece.outer[i];
    if (lonLatInClosedRect(lon, lat, minLon, minLat, maxLon, maxLat)) {
      return true;
    }
  }

  for (let i = 0; i < nv; i++) {
    const [x0, y0] = piece.outer[i];
    const [x1, y1] = piece.outer[(i + 1) % nv];
    if (
      segmentIntersectsClosedRect(
        x0,
        y0,
        x1,
        y1,
        minLon,
        minLat,
        maxLon,
        maxLat,
      )
    ) {
      return true;
    }
  }

  return false;
}

export function unionOuterBounds(oblast: BelarusOblastDefinition): {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
} {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const piece of oblast.pieces) {
    for (const [lo, la] of piece.outer) {
      minLon = Math.min(minLon, lo);
      maxLon = Math.max(maxLon, lo);
      minLat = Math.min(minLat, la);
      maxLat = Math.max(maxLat, la);
    }
  }
  if (!Number.isFinite(minLon)) {
    throw new Error(`Oblast ${oblast.id} has empty bounds`);
  }
  return { minLon, maxLon, minLat, maxLat };
}
