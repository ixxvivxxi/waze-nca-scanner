import { Module } from '@nestjs/common';
import { ScannerModule } from '../scanner/scanner.module';
import { ViewerApiController } from './viewer-api.controller';
import { ViewerNcaSampleService } from './viewer-nca-sample.service';
import { ViewerPageController } from './viewer-page.controller';
import { ViewerService } from './viewer.service';

@Module({
  imports: [ScannerModule],
  controllers: [ViewerApiController, ViewerPageController],
  providers: [ViewerService, ViewerNcaSampleService],
})
export class ViewerModule {}
