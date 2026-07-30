import {
  Controller,
  Get,
  Header,
  Query,
} from '@nestjs/common';
import { ViewerNcaSampleService } from './viewer-nca-sample.service';
import { ViewerService } from './viewer.service';

@Controller('api/viewer')
export class ViewerApiController {
  constructor(
    private readonly viewer: ViewerService,
    private readonly ncaSample: ViewerNcaSampleService,
  ) {}

  @Get('stats')
  getStats() {
    return this.viewer.getStats();
  }

  @Get('scan-active.json')
  @Header('Cache-Control', 'no-store')
  getScanActive() {
    return this.viewer.getScanActive();
  }

  @Get('scan-tiles.geojson')
  @Header('Cache-Control', 'no-store')
  getScanTiles(
    @Query('minLon') minLon: string,
    @Query('minLat') minLat: string,
    @Query('maxLon') maxLon: string,
    @Query('maxLat') maxLat: string,
    @Query('layerKind') layerKind?: string,
    @Query('limit') limit?: string,
  ) {
    return this.viewer.getScanTilesGeoJson(
      minLon,
      minLat,
      maxLon,
      maxLat,
      layerKind,
      limit,
    );
  }

  @Get('addresses.geojson')
  @Header('Cache-Control', 'no-store')
  getAddresses(
    @Query('minLon') minLon: string,
    @Query('minLat') minLat: string,
    @Query('maxLon') maxLon: string,
    @Query('maxLat') maxLat: string,
    @Query('limit') limit?: string,
  ) {
    return this.viewer.getAddressesGeoJson(
      minLon,
      minLat,
      maxLon,
      maxLat,
      limit,
    );
  }

  /**
   * Live WFS GetFeature for a bbox + upsert address points into DB.
   */
  @Get('nca-live.geojson')
  @Header('Cache-Control', 'no-store')
  getNcaLive(
    @Query('minLon') minLon: string,
    @Query('minLat') minLat: string,
    @Query('maxLon') maxLon: string,
    @Query('maxLat') maxLat: string,
  ) {
    return this.ncaSample.sampleLiveNca(minLon, minLat, maxLon, maxLat);
  }
}
