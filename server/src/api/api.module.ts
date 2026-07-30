import { Module } from '@nestjs/common';
import { AddressesController } from './addresses.controller';
import { AddressesNearbyService } from './addresses-nearby.service';

@Module({
  controllers: [AddressesController],
  providers: [AddressesNearbyService],
})
export class ApiModule {}
