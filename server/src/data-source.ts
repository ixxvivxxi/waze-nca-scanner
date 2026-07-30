import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { AddressPointEntity } from './scanner/entities/address-point.entity';
import { LandParcelEntity } from './scanner/entities/land-parcel.entity';
import { ScanTileEntity } from './scanner/entities/scan-tile.entity';
import { InitSchema1714210000000 } from './migrations/1714210000000-InitSchema';
import { ScanTileLastScanCompleted1745860000000 } from './migrations/1745860000000-ScanTileLastScanCompleted';
import { ScanTileAutoScanDisabled1745960000000 } from './migrations/1745960000000-ScanTileAutoScanDisabled';

dotenv.config();

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  entities: [AddressPointEntity, LandParcelEntity, ScanTileEntity],
  migrations: [
    InitSchema1714210000000,
    ScanTileLastScanCompleted1745860000000,
    ScanTileAutoScanDisabled1745960000000,
  ],
  synchronize: false,
  logging: false,
});
