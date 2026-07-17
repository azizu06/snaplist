export const PIPELINE_OPERATIONS_POLICY = {
  worker: {
    batchSize: 5,
    cadenceMinutes: 1,
    maxConcurrentInvocations: 5,
    maxAttempts: 3,
    maxDurationSeconds: 300,
    retryBaseSeconds: 30,
    retryMaxSeconds: 900,
    visibilityTimeoutSeconds: 300,
  },
  maintenance: {
    batchSize: 25,
    cadenceMinutes: 60,
    maxDurationSeconds: 300,
    storageLeaseSeconds: 600,
    storageMaxAttempts: 5,
  },
  retention: {
    abandonedItemDays: 30,
    completedQueueHours: 24,
    cronResponseDays: 7,
    httpResponseHours: 24,
    queueArchiveDays: 7,
    stagingHours: 24,
    terminalMetadataDays: 30,
  },
} as const;

/**
 * Published Free-plan allowances used for planning, not a live billing API.
 * Compute is intentionally represented separately because project compute is
 * not made free by staying under database, Storage, egress, or invocation caps.
 */
export const SUPABASE_FREE_PLAN_ALLOWANCES = {
  databaseBytes: 500_000_000,
  storageBytes: 1_000_000_000,
  egressBytes: 5_000_000_000,
  edgeFunctionInvocations: 500_000,
} as const;

export interface SupabaseFreePlanEstimateInput {
  days: number;
  runs: number;
  averagePhotosPerRun: number;
  averagePhotoBytes: number;
}

export interface SupabaseFreePlanUsageEstimate {
  databaseRows: number;
  databaseBytes: number;
  storageBytes: number;
  egressBytes: number;
  scheduledInvocations: number;
  computeIsMeteredSeparately: true;
}

export function estimateSupabaseFreePlanUsage(
  input: SupabaseFreePlanEstimateInput,
): SupabaseFreePlanUsageEstimate {
  const days = Math.max(0, Math.ceil(input.days));
  const runs = Math.max(0, Math.ceil(input.runs));
  const averagePhotosPerRun = Math.max(0, input.averagePhotosPerRun);
  const averagePhotoBytes = Math.max(0, input.averagePhotoBytes);
  const workerInvocations = days * 24 * (
    60 / PIPELINE_OPERATIONS_POLICY.worker.cadenceMinutes
  );
  const maintenanceInvocations = days * 24 * (
    60 / PIPELINE_OPERATIONS_POLICY.maintenance.cadenceMinutes
  );
  // One run normally creates an item, run, prediction, listing, and terminal
  // notification. Index overhead and JSONB are estimated conservatively here;
  // operators must use live database-size metrics before hosted activation.
  const databaseRows = runs * 5;

  return {
    databaseRows,
    databaseBytes: databaseRows * 4_096,
    storageBytes: Math.ceil(runs * averagePhotosPerRun * averagePhotoBytes),
    // A full processing read of each photo is the minimum pipeline egress
    // model. Retries and client downloads must be added from observed metrics.
    egressBytes: Math.ceil(runs * averagePhotosPerRun * averagePhotoBytes),
    scheduledInvocations: Math.ceil(workerInvocations + maintenanceInvocations),
    computeIsMeteredSeparately: true,
  };
}
