import proj4 from 'proj4';

const WGS84 = 'EPSG:4326';
const WEB_MERC = 'EPSG:3857';

function isLikelyWebMercatorPoint(coords: number[]): boolean {
  const [x, y] = coords;
  return Math.abs(x) > 1000 || Math.abs(y) > 1000;
}

/** Mutates copy: Point / Polygon / MultiPolygon coordinates → WGS84 if they look like EPSG:3857. */
export function geometryTo4326GeoJson(g: {
  type: string;
  coordinates: unknown;
}): { type: string; coordinates: unknown } {
  if (g.type === 'Point' && Array.isArray(g.coordinates)) {
    const c = g.coordinates as number[];
    if (c.length >= 2 && isLikelyWebMercatorPoint(c)) {
      const [lon, lat] = proj4(WEB_MERC, WGS84, [c[0], c[1]]);
      return { type: 'Point', coordinates: [lon, lat] };
    }
    return g;
  }
  if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
    const rings = g.coordinates as number[][][];
    const out = rings.map((ring) =>
      ring.map(([x, y]) => {
        if (isLikelyWebMercatorPoint([x, y])) {
          return proj4(WEB_MERC, WGS84, [x, y]);
        }
        return [x, y];
      }),
    );
    return { type: 'Polygon', coordinates: out };
  }
  if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
    const polys = g.coordinates as number[][][][];
    const out = polys.map((poly) =>
      poly.map((ring) =>
        ring.map(([x, y]) => {
          if (isLikelyWebMercatorPoint([x, y])) {
            return proj4(WEB_MERC, WGS84, [x, y]);
          }
          return [x, y];
        }),
      ),
    );
    return { type: 'MultiPolygon', coordinates: out };
  }
  return g;
}
