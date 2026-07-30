import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('address_points')
export class AddressPointEntity {
  @PrimaryColumn({ type: 'bigint', name: 'id_adr' })
  idAdr!: string;

  @Column({
    type: 'geometry',
    spatialFeatureType: 'Point',
    srid: 4326,
  })
  geom!: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  properties!: Record<string, unknown>;

  @Column({ type: 'text', nullable: true, name: 'wfs_feature_id' })
  wfsFeatureId!: string | null;

  @Column({ type: 'timestamptz', name: 'fetched_at', default: () => 'now()' })
  fetchedAt!: Date;
}
