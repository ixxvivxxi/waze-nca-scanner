export interface AppConfig {
  databaseUrl: string;
  geoserverBase: string;
  /** Optional dedicated WFS endpoint. When empty, WFS uses the same URL as geoserverBase. */
  geoserverWfsBase: string;
  geoserverReferer: string;
  wmsAddressLayer: string;
  wmsParcelLayer: string;
  wfsAddressTypename: string;
  wfsParcelTypename: string;
  wmsWidth: number;
  wmsHeight: number;
  wmsFeatureCount: number;
  wmsGrid: number;
  requestDelayMs: number;
  httpTimeoutMs: number;
  scanCron: string;
  scanIntervalMs: number;
  /**
   * When true and SCAN_CRON is empty: delay between ticks = (7×24 h)×SCAN_TILES_PER_RUN / scan_tiles row count
   * so the full queue is touched about once per week at steady state.
   */
  scanUseWeeklySpreadInterval: boolean;
  scanTilesPerRun: number;
  /** Re-run GeoServer scan for a tile after this many ms since last_scan_completed_at (done tiles). */
  scanRescanAfterMs: number;
  maxQuadDepth: number;
  /** Background scanner: WFS sub-cells per tile edge (same idea as viewer NCA subdivide). */
  scannerWfsSubdivide: number;
  /** If WFS returns at least this many unique features in a tile, mark saturated (quad-split). */
  scannerWfsSaturatedAt: number;
  /** WMS GetFeatureInfo grid size per sub-bbox for viewer live NCA (1–12). */
  viewerNcaGrid: number;
  /**
   * Reserved for optional WFS COUNT (viewer live NCA omits COUNT — server has no PK for paging).
   */
  viewerNcaWfsPageSize: number;
  /** Split bbox into subdiv×subdiv WGS84 sub-rectangles (each gets its own WMS extent). */
  viewerNcaSubdivide: number;
  /** Delay between live NCA viewer requests (ms); 0 disables. */
  viewerNcaRequestDelayMs: number;
  /** Max WGS84 span (max of lon/lat side) allowed for live NCA bbox requests. */
  viewerNcaMaxBboxSpanDeg: number;
  /**
   * WMS LAYERS for address GetFeatureInfo on viewer bbox click (NCA address points).
   * Default: pcm: + registry id 841cf07c-b35f-4012-a364-000000000002
   */
  viewerNcaWmsAddressLayer: string;
  /** GetFeatureInfo WIDTH for viewer NCA (finer pixels ≈ more address hits per bbox). */
  viewerNcaWmsWidth: number;
  viewerNcaWmsHeight: number;
  /** FEATURE_COUNT per GetFeatureInfo call for viewer NCA. */
  viewerNcaFeatureCount: number;
  /**
   * Optional WMS STYLES for address GetFeatureInfo (e.g. pcm:…_text on GetMap).
   * Default empty: label styles often return fewer/no features for GetFeatureInfo.
   */
  viewerNcaWmsAddressStyles: string;
}

export default (): AppConfig => ({
  databaseUrl: process.env.DATABASE_URL ?? '',
  geoserverBase:
    process.env.GEOSERVER_BASE ?? 'https://map.nca.by/geoserver/pcm/ows',
  geoserverWfsBase: (process.env.GEOSERVER_WFS_BASE ?? '').trim(),
  geoserverReferer: process.env.GEOSERVER_REFERER ?? 'https://map.nca.by/',
  wmsAddressLayer:
    process.env.WMS_ADDRESS_LAYER ?? 'pcm:841cf07c-b35f-4012-a364-000000000002',
  wmsParcelLayer:
    process.env.WMS_PARCEL_LAYER ?? 'pcm:294b19b9-3259-44e5-b8e8-5314b0adf928',
  wfsAddressTypename:
    process.env.WFS_ADDRESS_TYPENAME ?? '841cf07c-b35f-4012-a364-000000000002',
  wfsParcelTypename:
    process.env.WFS_PARCEL_TYPENAME ?? '294b19b9-3259-44e5-b8e8-5314b0adf928',
  wmsWidth: Number(process.env.WMS_WIDTH ?? 512),
  wmsHeight: Number(process.env.WMS_HEIGHT ?? 512),
  wmsFeatureCount: Number(process.env.WMS_FEATURE_COUNT ?? 50),
  wmsGrid: Math.max(1, Number(process.env.WMS_GRID ?? 8)),
  requestDelayMs: Number(process.env.REQUEST_DELAY_MS ?? 800),
  httpTimeoutMs: Number(process.env.HTTP_TIMEOUT_MS ?? 45000),
  scanCron: process.env.SCAN_CRON ?? '',
  scanIntervalMs: Math.max(
    0,
    Number(process.env.SCAN_INTERVAL_MS ?? 86_400_000),
  ),
  scanUseWeeklySpreadInterval: (() => {
    const r = (process.env.SCAN_USE_WEEKLY_SPREAD ?? 'true')
      .trim()
      .toLowerCase();
    return r !== '0' && r !== 'false' && r !== 'no' && r !== 'off';
  })(),
  scanTilesPerRun: Math.max(1, Number(process.env.SCAN_TILES_PER_RUN ?? 1)),
  scanRescanAfterMs: Math.max(
    60_000,
    Number(process.env.SCAN_RESCAN_AFTER_MS ?? 604_800_000),
  ),
  maxQuadDepth: Math.max(0, Number(process.env.MAX_QUAD_DEPTH ?? 12)),
  scannerWfsSubdivide: Math.min(
    12,
    Math.max(1, Number(process.env.SCANNER_WFS_SUBDIVIDE ?? 4)),
  ),
  scannerWfsSaturatedAt: Math.max(
    50,
    Number(process.env.SCANNER_WFS_SATURATED_AT ?? 2500),
  ),
  viewerNcaGrid: Math.min(
    12,
    Math.max(1, Number(process.env.VIEWER_NCA_GRID ?? 5)),
  ),
  viewerNcaWfsPageSize: Math.min(
    10_000,
    Math.max(100, Number(process.env.VIEWER_NCA_WFS_PAGE_SIZE ?? 4000)),
  ),
  viewerNcaSubdivide: Math.min(
    8,
    Math.max(1, Number(process.env.VIEWER_NCA_SUBDIVIDE ?? 4)),
  ),
  viewerNcaRequestDelayMs: Math.max(
    0,
    Number(process.env.VIEWER_NCA_REQUEST_DELAY_MS ?? 90),
  ),
  viewerNcaMaxBboxSpanDeg: Math.max(
    0.001,
    Number(process.env.VIEWER_NCA_MAX_BBOX_SPAN_DEG ?? 0.12),
  ),
  viewerNcaWmsAddressLayer:
    process.env.VIEWER_NCA_WMS_ADDRESS_LAYER ??
    'pcm:841cf07c-b35f-4012-a364-000000000002',
  viewerNcaWmsWidth: Math.min(
    4096,
    Math.max(256, Number(process.env.VIEWER_NCA_WMS_WIDTH ?? 1280)),
  ),
  viewerNcaWmsHeight: Math.min(
    4096,
    Math.max(256, Number(process.env.VIEWER_NCA_WMS_HEIGHT ?? 1280)),
  ),
  viewerNcaFeatureCount: Math.min(
    200,
    Math.max(1, Number(process.env.VIEWER_NCA_FEATURE_COUNT ?? 120)),
  ),
  viewerNcaWmsAddressStyles: (
    process.env.VIEWER_NCA_WMS_ADDRESS_STYLES ?? ''
  ).trim(),
});
