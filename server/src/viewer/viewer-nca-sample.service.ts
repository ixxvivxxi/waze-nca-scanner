import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GeoJsonFeatureCollection } from '../scanner/geojson-types';
import { GeoserverClient } from '../scanner/geoserver.client';
import { IngestService } from '../scanner/ingest.service';
import {
  fetchNcaWfsFeaturesForLonLatBBox,
  qualifiedWfsTypeNames,
} from '../scanner/nca-wfs-tile-fetch';
import { ScannerService } from '../scanner/scanner.service';

function bboxSpanDeg(
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): number {
  return Math.max(Math.abs(maxLon - minLon), Math.abs(maxLat - minLat));
}

@Injectable()
export class ViewerNcaSampleService {
  private readonly log = new Logger(ViewerNcaSampleService.name);

  constructor(
    private readonly geo: GeoserverClient,
    private readonly config: ConfigService,
    private readonly ingest: IngestService,
    private readonly scanner: ScannerService,
  ) {}

  async sampleLiveNca(
    minLonStr: string,
    minLatStr: string,
    maxLonStr: string,
    maxLatStr: string,
  ): Promise<GeoJsonFeatureCollection> {
    const minLon = Number(minLonStr);
    const minLat = Number(minLatStr);
    const maxLon = Number(maxLonStr);
    const maxLat = Number(maxLatStr);
    if (
      !Number.isFinite(minLon) ||
      !Number.isFinite(minLat) ||
      !Number.isFinite(maxLon) ||
      !Number.isFinite(maxLat)
    ) {
      throw new BadRequestException('Invalid bbox');
    }
    const minX = Math.min(minLon, maxLon);
    const maxX = Math.max(minLon, maxLon);
    const minY = Math.min(minLat, maxLat);
    const maxY = Math.max(minLat, maxLat);
    const span = bboxSpanDeg(minX, minY, maxX, maxY);
    const maxSpan = Number(this.config.get('viewerNcaMaxBboxSpanDeg') ?? 0.12);
    if (span > maxSpan) {
      throw new BadRequestException(
        `bbox span ${span.toFixed(4)}° exceeds limit ${maxSpan}°`,
      );
    }

    const wmsLayer = String(
      this.config.get('viewerNcaWmsAddressLayer') ??
        'pcm:841cf07c-b35f-4012-a364-000000000002',
    );
    const wfsTypename = String(this.config.get('wfsAddressTypename') ?? '');
    const typeNames = qualifiedWfsTypeNames(wmsLayer, wfsTypename);

    const subdiv = Number(this.config.get('viewerNcaSubdivide') ?? 4);
    const delayMs = Number(this.config.get('viewerNcaRequestDelayMs') ?? 90);

    const merged = await fetchNcaWfsFeaturesForLonLatBBox({
      geo: this.geo,
      typeNames,
      layerKind: 'addresses',
      minLon: minX,
      minLat: minY,
      maxLon: maxX,
      maxLat: maxY,
      subdiv,
      delayMs,
      warn: (m) => this.log.warn(m),
    });

    let ingestedCount = 0;
    if (merged.length > 0) {
      ingestedCount = await this.ingest.upsertAddressFeatures(merged);
      if (ingestedCount > 0) {
        await this.scanner.reenableAutoScanForManualIngest(
          'addresses',
          minX,
          minY,
          maxX,
          maxY,
        );
      }
    }

    this.log.log(
      `nca-live addresses: subdiv=${subdiv} wfsUrl=${this.geo.getWfsUrl()} (unpaged WFS per subcell) → ${merged.length} features from NCA, ${ingestedCount} rows upserted`,
    );

    return {
      type: 'FeatureCollection',
      features: merged,
      ingestedCount,
    };
  }
}
