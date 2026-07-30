import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ScannerService } from '../scanner/scanner.service';

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const scanner = app.get(ScannerService);
    await scanner.resetScannerData();
  } finally {
    await app.close();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
