import { MigrationInterface, QueryRunner } from 'typeorm';

export class ScanTileAutoScanDisabled1745960000000
  implements MigrationInterface
{
  name = 'ScanTileAutoScanDisabled1745960000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE scan_tiles
      ADD COLUMN IF NOT EXISTS auto_scan_disabled BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_scan_tiles_auto_status_layer
      ON scan_tiles (auto_scan_disabled, status, layer_kind)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX IF EXISTS idx_scan_tiles_auto_status_layer
    `);
    await queryRunner.query(`
      ALTER TABLE scan_tiles
      DROP COLUMN IF EXISTS auto_scan_disabled
    `);
  }
}
