import { Controller, Get, Query } from '@nestjs/common';
import {
  AddressesNearbyService,
  type NearbyAddressRow,
} from './addresses-nearby.service';

export interface NearbyAddressesResponse {
  addresses: NearbyAddressRow[];
}

@Controller('api/addresses')
export class AddressesController {
  constructor(private readonly addressesNearby: AddressesNearbyService) {}

  @Get('nearby')
  async getNearby(
    @Query('lon') lonStr: string,
    @Query('lat') latStr: string,
    @Query('radiusM') radiusStr?: string,
    @Query('limit') limitStr?: string,
  ): Promise<NearbyAddressesResponse> {
    const lon = Number(lonStr);
    const lat = Number(latStr);
    const radiusM = radiusStr != null ? Number(radiusStr) : 200;
    const limit = limitStr != null ? Number(limitStr) : 25;
    const addresses = await this.addressesNearby.findNearby(
      lon,
      lat,
      radiusM,
      limit,
    );
    return { addresses };
  }

  @Get('bbox')
  async getBBox(
    @Query('minLon') minLonStr: string,
    @Query('minLat') minLatStr: string,
    @Query('maxLon') maxLonStr: string,
    @Query('maxLat') maxLatStr: string,
  ): Promise<NearbyAddressesResponse> {
    const minLon = Number(minLonStr);
    const minLat = Number(minLatStr);
    const maxLon = Number(maxLonStr);
    const maxLat = Number(maxLatStr);
    const addresses = await this.addressesNearby.findInBbox(
      minLon,
      minLat,
      maxLon,
      maxLat,
    );
    return { addresses };
  }
}
