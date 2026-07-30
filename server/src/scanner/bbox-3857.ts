import proj4 from 'proj4';

const WGS84 = 'EPSG:4326';
const WEB_MERC = 'EPSG:3857';

/**
 * Returns BBOX string for WMS 1.3.0 EPSG:3857: minX,minY,maxX,maxY
 */
export function lonLatTileToBbox3857(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): string {
  const corners: [number, number][] = [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
  ];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lon, lat] of corners) {
    const [x, y] = proj4(WGS84, WEB_MERC, [lon, lat]);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return `${minX},${minY},${maxX},${maxY}`;
}
