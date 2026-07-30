export interface GeoJsonFeature {
  type: 'Feature';
  id?: string;
  geometry?: { type: string; coordinates: unknown };
  properties?: Record<string, unknown>;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
  numberReturned?: number;
  totalFeatures?: string | number;
  /** Set by nca-live viewer endpoint after DB upsert. */
  ingestedCount?: number;
}
