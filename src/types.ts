export type SourceState = "ok" | "error";
export type FreshnessState = "fresh" | "possibly_stale" | "partial" | "unavailable";

export interface SourceResult {
  state: SourceState;
  hash?: string;
  repeatCount?: number;
  responseDate?: string | null;
  cacheControl?: string | null;
  age?: string | null;
  error?: string;
}

export interface CarStatistics {
  carLastHour: number;
  carLastDay: number;
  averagePerHour24: number;
}

export interface VehicleTimelinePoint {
  registrationAt: string | null;
  changedAt: string | null;
  orderId: number | null;
  status: number | null;
  typeQueue: number | null;
}

export interface QueueTiming {
  oldestRegistrationAt: string | null;
  newestRegistrationAt: string | null;
  latestChangedAt: string | null;
  medianWaitingHours: number | null;
}

export interface QueueComposition {
  statusCounts: Record<string, number>;
  typeQueueCounts: Record<string, number>;
  withOrderId: number;
  withoutOrderId: number;
}

export interface QueueSnapshot {
  collectedAt: string;
  checkpointId: string;
  queueLength: number | null;
  queueChange: number | null;
  statistics: CarStatistics | null;
  registrationsObservedLastHour: number | null;
  estimatedRegistrationsLastHour: number | null;
  collectionIntervalHours?: number | null;
  registrationsObservedSincePrevious?: number | null;
  estimatedRegistrationsSincePrevious?: number | null;
  queueComposition?: QueueComposition | null;
  freshness: FreshnessState;
  warnings: string[];
  queueTiming: QueueTiming | null;
  vehicleTimeline?: VehicleTimelinePoint[];
  source: {
    statistics: SourceResult;
    monitoring: SourceResult;
  };
}

export interface HistoryFile {
  schemaVersion: number;
  checkpoint: {
    id: string;
    name: string;
  };
  updatedAt: string | null;
  snapshots: QueueSnapshot[];
}
