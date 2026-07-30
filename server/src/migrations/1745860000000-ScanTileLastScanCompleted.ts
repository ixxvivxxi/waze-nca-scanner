import { MigrationInterface, QueryRunner } from 'typeorm';

export class ScanTileLastScanCompleted1745860000000
  implements MigrationInterface
{
  name = 'ScanTileLastScanCompleted1745860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE scan_tiles
      ADD COLUMN IF NOT EXISTS last_scan_completed_at TIMESTAMPTZ NULL
    `);
    await queryRunner.query(`
      UPDATE scan_tiles
      SET last_scan_completed_at = updated_at
      WHERE status = 'done' AND last_scan_completed_at IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE scan_tiles DROP COLUMN IF EXISTS last_scan_completed_at
    `);
  }
}
