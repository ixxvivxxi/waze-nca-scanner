import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitSchema1714210000000 implements MigrationInterface {
  name = 'InitSchema1714210000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS postgis`);

    await queryRunner.query(`
      CREATE TABLE address_points (
        id_adr BIGINT PRIMARY KEY,
        geom geometry(Point, 4326) NOT NULL,
        properties JSONB NOT NULL DEFAULT '{}',
        wfs_feature_id TEXT,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_address_points_geom ON address_points USING GIST (geom)`,
    );

    await queryRunner.query(`
      CREATE TABLE land_parcels (
        wfs_feature_id TEXT PRIMARY KEY,
        cad_num TEXT,
        object_id BIGINT,
        geom geometry(MultiPolygon, 4326) NOT NULL,
        properties JSONB NOT NULL DEFAULT '{}',
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_land_parcels_cad_num ON land_parcels (cad_num)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_land_parcels_geom ON land_parcels USING GIST (geom)`,
    );

    await queryRunner.query(`
      CREATE TABLE scan_tiles (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        layer_kind VARCHAR(16) NOT NULL,
        region_id VARCHAR(64) NOT NULL,
        min_lon DOUBLE PRECISION NOT NULL,
        min_lat DOUBLE PRECISION NOT NULL,
        max_lon DOUBLE PRECISION NOT NULL,
        max_lat DOUBLE PRECISION NOT NULL,
        tile_key VARCHAR(128) NOT NULL UNIQUE,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        depth INT NOT NULL DEFAULT 0,
        parent_tile_key VARCHAR(128),
        retry_count INT NOT NULL DEFAULT 0,
        auto_scan_disabled BOOLEAN NOT NULL DEFAULT FALSE,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_scan_tiles_status_layer ON scan_tiles (status, layer_kind)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_scan_tiles_auto_status_layer ON scan_tiles (auto_scan_disabled, status, layer_kind)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS scan_tiles`);
    await queryRunner.query(`DROP TABLE IF EXISTS land_parcels`);
    await queryRunner.query(`DROP TABLE IF EXISTS address_points`);
  }
}
