import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AddressPointEntity } from './entities/address-point.entity';
import { LandParcelEntity } from './entities/land-parcel.entity';
import { ScanTileEntity } from './entities/scan-tile.entity';
import { GeoserverClient } from './geoserver.client';
import { IngestService } from './ingest.service';
import { ScannerService } from './scanner.service';

@Module({
  imports: [
    HttpModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        timeout: Number(config.get('httpTimeoutMs') ?? 45_000),
      }),
    }),
    TypeOrmModule.forFeature([
      ScanTileEntity,
      AddressPointEntity,
      LandParcelEntity,
    ]),
  ],
  providers: [GeoserverClient, IngestService, ScannerService],
  exports: [ScannerService, GeoserverClient, IngestService],
})
export class ScannerModule {}
