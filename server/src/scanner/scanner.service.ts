import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Brackets, Repository } from 'typeorm';
import { BELARUS_TILE_GROUPS } from './belarus-regions';
import type { ScanLayerKind } from './entities/scan-tile.entity';
import { ScanTileEntity } from './entities/scan-tile.entity';
import { GeoserverClient } from './geoserver.client';
import { IngestService } from './ingest.service';
import {
  fetchNcaWfsFeaturesForLonLatBBox,
  qualifiedWfsTypeNames,
} from './nca-wfs-tile-fetch';
import { makeTileKey, quadSplit, type LonLatTile } from './tile-grid';

const MIN_TILE_DEG = 0.0008;

/** Bbox the background scanner is processing (exposed for /viewer). */
export interface ScannerActiveTile {
  tileKey: string;
  layerKind: string;
  regionId: string;
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

/** One calendar week in ms (7 × 24 h). */
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const MIN_WEEKLY_SPREAD_DELAY_MS = 1000;

/**
 * Time between ticks so that `tilesPerRun` tiles each tick cycles all `tileCount` rows in ~one week.
 * Formula: (7×24 h) / (tileCount / tilesPerRun) = MS_PER_WEEK × tilesPerRun / tileCount.
 */
function delayMsForWeeklySpreadAllTiles(
  tileCount: number,
  tilesPerRun: number,
): number {
  const n = Math.max(1, Math.floor(tileCount));
  const k = Math.max(1, Math.floor(tilesPerRun));
  return Math.max(MIN_WEEKLY_SPREAD_DELAY_MS, Math.floor((MS_PER_WEEK * k) / n));
}

@Injectable()
export class ScannerService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly log = new Logger(ScannerService.name);
  private cronJob: CronJob | null = null;
  private intervalRef: ReturnType<typeof setInterval> | null = null;
  private spreadTimeoutRef: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private tickRunning = false;
  /** Coalesce overlapping runTick calls (cron/interval fire while previous tick still awaits I/O). */
  private tickPending = false;
  private activeTile: ScannerActiveTile | null = null;

  /** Current scan-tile bbox for the viewer map (null between tiles). */
  getActiveScanTile(): ScannerActiveTile | null {
    return this.activeTile;
  }

  constructor(
    @InjectRepository(ScanTileEntity)
    private readonly scanTiles: Repository<ScanTileEntity>,
    private readonly geo: GeoserverClient,
    private readonly ingest: IngestService,
    private readonly config: ConfigService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.seedTilesIfEmpty();
    const cronExpr = String(this.config.get('scanCron') ?? '').trim();
    if (cronExpr) {
      this.cronJob = new CronJob(cronExpr, () => {
        void this.runTick();
      });
      this.schedulerRegistry.addCronJob('ncaMapScan', this.cronJob);
      this.cronJob.start();
      this.log.log(`Scheduled scan cron: "${cronExpr}"`);
    } else {
      const useWeekly = Boolean(
        this.config.get('scanUseWeeklySpreadInterval'),
      );
      if (useWeekly) {
        const n = await this.scanTiles.count();
        const perRun = Math.max(
          1,
          Number(this.config.get('scanTilesPerRun') ?? 1),
        );
        const nextMs =
          n <= 0 ? 60_000 : delayMsForWeeklySpreadAllTiles(n, perRun);
        this.log.log(
          `Scheduled scan: weekly spread over scan_tiles (rows=${n}, ${perRun} tile(s)/tick → ~${Math.round(nextMs / 1000)}s until next tick; target one full pass / week)`,
        );
        void this.runTickThenScheduleWeeklySpread();
      } else {
        const ms = Number(this.config.get('scanIntervalMs') ?? 0);
        if (ms > 0) {
          this.intervalRef = setInterval(() => {
            void this.runTick();
          }, ms);
          this.log.log(`Scheduled scan interval: ${ms} ms`);
        } else {
          this.log.warn(
            'SCAN_USE_WEEKLY_SPREAD disabled and SCAN_INTERVAL_MS is 0 — scanner only runs via manual runTick()',
          );
        }
      }
    }
  }

  onApplicationShutdown(): void {
    this.destroyed = true;
    void this.cronJob?.stop();
    if (this.intervalRef) clearInterval(this.intervalRef);
    if (this.spreadTimeoutRef) {
      clearTimeout(this.spreadTimeoutRef);
      this.spreadTimeoutRef = null;
    }
  }

  /** One tick, then schedule the next after a delay derived from current scan_tiles count. */
  private async runTickThenScheduleWeeklySpread(): Promise<void> {
    if (this.destroyed) return;
    try {
      await this.runTick();
    } finally {
      if (!this.destroyed) {
        await this.scheduleNextWeeklySpreadTick();
      }
    }
  }

  private async scheduleNextWeeklySpreadTick(): Promise<void> {
    if (this.destroyed) return;
    if (this.spreadTimeoutRef) {
      clearTimeout(this.spreadTimeoutRef);
      this.spreadTimeoutRef = null;
    }
    const total = await this.scanTiles.count();
    const perRun = Math.max(
      1,
      Number(this.config.get('scanTilesPerRun') ?? 1),
    );
    const delayMs =
      total <= 0 ? 60_000 : delayMsForWeeklySpreadAllTiles(total, perRun);
    this.spreadTimeoutRef = setTimeout(() => {
      this.spreadTimeoutRef = null;
      void this.runTickThenScheduleWeeklySpread();
    }, delayMs);
  }

  async seedTilesIfEmpty(): Promise<void> {
    const n = await this.scanTiles.count();
    if (n > 0) return;
    await this.insertAllSeedTiles();
    const total = await this.scanTiles.count();
    this.log.log(
      `Seeded scan_tiles (approx rows attempted); total in DB: ${total}`,
    );
  }

  /**
   * Drops all scan queue rows and inserts the full Belarus seed grid for both layers.
   * Does not modify address_points or land_parcels.
   */
  async reseedScanTiles(): Promise<void> {
    await this.scanTiles.query('TRUNCATE TABLE scan_tiles');
    await this.insertAllSeedTiles();
    const total = await this.scanTiles.count();
    this.log.log(`Reseeded scan_tiles; total rows: ${total}`);
  }

  /**
   * Clears ingested features and the scan queue, then seeds scan_tiles from scratch.
   */
  async resetScannerData(): Promise<void> {
    await this.scanTiles.query(
      'TRUNCATE TABLE address_points, land_parcels, scan_tiles',
    );
    await this.insertAllSeedTiles();
    const total = await this.scanTiles.count();
    this.log.log(
      `Reset scanner DB (address_points, land_parcels, scan_tiles cleared); scan_tiles rows: ${total}`,
    );
  }

  private async insertAllSeedTiles(): Promise<void> {
    const layers: ScanLayerKind[] = ['addresses', 'parcels'];
    for (const group of BELARUS_TILE_GROUPS) {
      for (const box of group.bboxes) {
        const t: LonLatTile = {
          regionId: box.id,
          minLon: box.minLon,
          minLat: box.minLat,
          maxLon: box.maxLon,
          maxLat: box.maxLat,
          depth: 0,
          parentTileKey: null,
        };
        for (const layerKind of layers) {
          const tileKey = makeTileKey(layerKind, t);
          await this.scanTiles.query(
            `INSERT INTO scan_tiles (layer_kind, region_id, min_lon, min_lat, max_lon, max_lat, tile_key, status, depth, parent_tile_key, retry_count, auto_scan_disabled)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,0,false)
             ON CONFLICT (tile_key) DO NOTHING`,
            [
              layerKind,
              t.regionId,
              t.minLon,
              t.minLat,
              t.maxLon,
              t.maxLat,
              tileKey,
              t.depth,
              t.parentTileKey,
            ],
          );
        }
      }
    }
  }

  async runTick(): Promise<void> {
    if (this.tickRunning) {
      this.tickPending = true;
      return;
    }
    this.tickRunning = true;
    try {
      do {
        this.tickPending = false;
        await this.runTickBody();
      } while (this.tickPending);
    } finally {
      const runAgain = this.tickPending;
      this.tickPending = false;
      this.tickRunning = false;
      if (runAgain) {
        void this.runTick();
      }
    }
  }

  private async runTickBody(): Promise<void> {
    const limit = Number(this.config.get('scanTilesPerRun') ?? 1);
    const rescanMs = Number(this.config.get('scanRescanAfterMs') ?? 604_800_000);
    const rescanSec = Math.max(60, Math.floor(rescanMs / 1000));
    const eligible = await this.scanTiles
      .createQueryBuilder('st')
      .where(
        new Brackets((qb) => {
          qb.where('st.auto_scan_disabled = false').andWhere(
            new Brackets((qs) => {
              qs.where('st.status = :pending', { pending: 'pending' })
                .orWhere('(st.status = :failed AND st.retry_count < :maxR)', {
                  failed: 'failed',
                  maxR: 5,
                })
                .orWhere(
                  '(st.status = :done AND (st.last_scan_completed_at IS NULL OR st.last_scan_completed_at < NOW() - CAST(:ival AS interval)))',
                  { done: 'done', ival: `${rescanSec} seconds` },
                );
            }),
          );
        }),
      )
      .orderBy(
        `CASE st.status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END`,
        'ASC',
      )
      .addOrderBy('COALESCE(st.last_scan_completed_at, st.created_at)', 'ASC')
      .addOrderBy('st.created_at', 'ASC')
      .limit(limit)
      .getMany();
    if (eligible.length === 0) {
      this.log.debug(
        'No eligible scan tiles (pending / failed retry / done past rescan window)',
      );
      return;
    }
    for (const row of eligible) {
      try {
        await this.processTileRow(row);
        await this.scanTiles.update(
          { id: row.id },
          {
            status: 'done',
            lastError: null,
            lastScanCompletedAt: new Date(),
          },
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const retries = row.retryCount + 1;
        const failed = retries >= 5;
        await this.scanTiles.update(
          { id: row.id },
          {
            status: failed ? 'failed' : 'pending',
            retryCount: retries,
            lastError: msg.slice(0, 2000),
          },
        );
        this.log.warn(
          `Tile ${row.tileKey} ${failed ? 'failed' : 'retry'}: ${msg}`,
        );
      }
    }
  }

  private async processTileRow(row: ScanTileEntity): Promise<void> {
    this.activeTile = {
      tileKey: row.tileKey,
      layerKind: row.layerKind,
      regionId: row.regionId,
      minLon: row.minLon,
      minLat: row.minLat,
      maxLon: row.maxLon,
      maxLat: row.maxLat,
    };
    try {
      const wmsLayer =
        row.layerKind === 'addresses'
          ? String(
              this.config.get('viewerNcaWmsAddressLayer') ??
                this.config.get('wmsAddressLayer') ??
                'pcm:841cf07c-b35f-4012-a364-000000000002',
            )
          : String(
              this.config.get('wmsParcelLayer') ??
                'pcm:294b19b9-3259-44e5-b8e8-5314b0adf928',
            );
      const wfsTypename =
        row.layerKind === 'addresses'
          ? String(this.config.get('wfsAddressTypename') ?? '')
          : String(this.config.get('wfsParcelTypename') ?? '');
      const typeNames = qualifiedWfsTypeNames(wmsLayer, wfsTypename);
      const subdiv = Number(this.config.get('scannerWfsSubdivide') ?? 4);
      const satAt = Number(this.config.get('scannerWfsSaturatedAt') ?? 2500);
      const delayMs = Number(this.config.get('requestDelayMs') ?? 800);

      const merged = await fetchNcaWfsFeaturesForLonLatBBox({
        geo: this.geo,
        typeNames,
        layerKind: row.layerKind,
        minLon: row.minLon,
        minLat: row.minLat,
        maxLon: row.maxLon,
        maxLat: row.maxLat,
        subdiv,
        delayMs,
        warn: (m) => this.log.warn(m),
      });

      const saturated = merged.length >= satAt;
      let ingestedAddr = 0;
      let ingestedParcels = 0;
      if (row.layerKind === 'addresses') {
        ingestedAddr = await this.ingest.upsertAddressFeatures(merged);
      } else {
        ingestedParcels = await this.ingest.upsertParcelFeatures(merged);
      }
      const emptyFromNca = merged.length === 0;
      const spanLon = row.maxLon - row.minLon;
      const spanLat = row.maxLat - row.minLat;
      const maxDepth = Number(this.config.get('maxQuadDepth') ?? 12);
      const canSplit =
        saturated &&
        row.depth < maxDepth &&
        spanLon > MIN_TILE_DEG * 1.5 &&
        spanLat > MIN_TILE_DEG * 1.5;
      if (canSplit) {
        const lonLat: LonLatTile = {
          regionId: row.regionId,
          minLon: row.minLon,
          minLat: row.minLat,
          maxLon: row.maxLon,
          maxLat: row.maxLat,
          depth: row.depth,
          parentTileKey: row.parentTileKey,
        };
        const children = quadSplit(row.layerKind, lonLat);
        for (const c of children) {
          const tileKey = makeTileKey(row.layerKind, c);
          await this.scanTiles.query(
            `INSERT INTO scan_tiles (layer_kind, region_id, min_lon, min_lat, max_lon, max_lat, tile_key, status, depth, parent_tile_key, retry_count, auto_scan_disabled)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,0,false)
             ON CONFLICT (tile_key) DO NOTHING`,
            [
              row.layerKind,
              c.regionId,
              c.minLon,
              c.minLat,
              c.maxLon,
              c.maxLat,
              tileKey,
              c.depth,
              c.parentTileKey,
            ],
          );
        }
        this.log.log(
          `Quad-split tile ${row.tileKey} → ${children.length} children (${row.layerKind})`,
        );
      }
      this.log.log(
        `Tile done ${row.tileKey} [${row.layerKind}] depth=${row.depth} wfsFeatures=${merged.length} ingested addr=${ingestedAddr} parcels=${ingestedParcels} saturated=${saturated} autoDisabled=${emptyFromNca}`,
      );
      if (emptyFromNca && !row.autoScanDisabled) {
        await this.scanTiles.update(
          { id: row.id },
          {
            autoScanDisabled: true,
            lastError: null,
          },
        );
        row.autoScanDisabled = true;
      }
    } finally {
      this.activeTile = null;
    }
  }

  /**
   * Manual (nca-live) successful ingest can re-enable auto scanning for intersecting disabled rows.
   * Called only when manual fetch produced and ingested actual data.
   */
  async reenableAutoScanForManualIngest(
    layerKind: ScanLayerKind,
    minLon: number,
    minLat: number,
    maxLon: number,
    maxLat: number,
  ): Promise<number> {
    const minX = Math.min(minLon, maxLon);
    const maxX = Math.max(minLon, maxLon);
    const minY = Math.min(minLat, maxLat);
    const maxY = Math.max(minLat, maxLat);
    const result = await this.scanTiles
      .createQueryBuilder()
      .update(ScanTileEntity)
      .set({
        autoScanDisabled: false,
        status: 'pending',
        retryCount: 0,
        lastError: null,
        lastScanCompletedAt: null,
      })
      .where('layer_kind = :layerKind', { layerKind })
      .andWhere('auto_scan_disabled = true')
      .andWhere('NOT (max_lon < :minX OR min_lon > :maxX OR max_lat < :minY OR min_lat > :maxY)', {
        minX,
        maxX,
        minY,
        maxY,
      })
      .execute();
    const changed = Number(result.affected ?? 0);
    if (changed > 0) {
      this.log.log(
        `Manual live ingest re-enabled auto scan for ${changed} tile(s) layer=${layerKind} bbox=[${minX},${minY}]..[${maxX},${maxY}]`,
      );
    }
    return changed;
  }
}
