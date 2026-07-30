import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('land_parcels')
export class LandParcelEntity {
  @PrimaryColumn({ type: 'text', name: 'wfs_feature_id' })
  wfsFeatureId!: string;

  @Column({ type: 'text', nullable: true, name: 'cad_num' })
  cadNum!: string | null;

  @Column({ type: 'bigint', nullable: true, name: 'object_id' })
  objectId!: string | null;

  @Column({
    type: 'geometry',
    spatialFeatureType: 'MultiPolygon',
    srid: 4326,
  })
  geom!: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  properties!: Record<string, unknown>;

  @Column({ type: 'timestamptz', name: 'fetched_at', default: () => 'now()' })
  fetchedAt!: Date;
}
