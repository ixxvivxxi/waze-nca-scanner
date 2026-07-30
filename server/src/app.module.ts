import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from './config/configuration';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AddressPointEntity } from './scanner/entities/address-point.entity';
import { LandParcelEntity } from './scanner/entities/land-parcel.entity';
import { ScanTileEntity } from './scanner/entities/scan-tile.entity';
import { ScannerModule } from './scanner/scanner.module';
import { ApiModule } from './api/api.module';
import { ViewerModule } from './viewer/viewer.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('databaseUrl'),
        entities: [AddressPointEntity, LandParcelEntity, ScanTileEntity],
        synchronize: false,
        logging: false,
      }),
    }),
    ScheduleModule.forRoot(),
    ScannerModule,
    ApiModule,
    ViewerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
