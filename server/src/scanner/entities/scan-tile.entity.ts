import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm'

export type ScanLayerKind = 'addresses' | 'parcels'

@Entity('scan_tiles')
export class ScanTileEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string

  @Column({ type: 'varchar', length: 16, name: 'layer_kind' })
  layerKind!: ScanLayerKind

  @Column({ type: 'varchar', length: 64, name: 'region_id' })
  regionId!: string

  @Column({ type: 'double precision', name: 'min_lon' })
  minLon!: number

  @Column({ type: 'double precision', name: 'min_lat' })
  minLat!: number

  @Column({ type: 'double precision', name: 'max_lon' })
  maxLon!: number

  @Column({ type: 'double precision', name: 'max_lat' })
  maxLat!: number

  @Column({ type: 'varchar', length: 128, name: 'tile_key', unique: true })
  tileKey!: string

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: 'pending' | 'done' | 'failed'

  @Column({ type: 'int', default: 0 })
  depth!: number

  @Column({ type: 'varchar', length: 128, nullable: true, name: 'parent_tile_key' })
  parentTileKey!: string | null

  @Column({ type: 'int', name: 'retry_count', default: 0 })
  retryCount!: number

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError!: string | null

  /** Auto-scanner skip flag for repeatedly empty tiles; can be re-enabled by successful manual live ingest. */
  @Column({ type: 'boolean', name: 'auto_scan_disabled', default: false })
  autoScanDisabled!: boolean

  /** Set when a scan tick finishes this tile successfully; used for SCAN_RESCAN_AFTER_MS. */
  @Column({ type: 'timestamptz', nullable: true, name: 'last_scan_completed_at' })
  lastScanCompletedAt!: Date | null

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date
}
