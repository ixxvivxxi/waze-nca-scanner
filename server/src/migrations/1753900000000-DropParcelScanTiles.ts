import { MigrationInterface, QueryRunner } from 'typeorm';

/** Drop parcel scan queue; app scans address points only. */
export class DropParcelScanTiles1753900000000 implements MigrationInterface {
  name = 'DropParcelScanTiles1753900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM scan_tiles WHERE layer_kind = 'parcels'`,
    );
    await queryRunner.query(`TRUNCATE TABLE land_parcels`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Parcel queue is not restored; reseed via npm run scan:reseed if needed.
    void queryRunner;
  }
}
