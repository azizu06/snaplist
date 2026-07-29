interface RunHistoryProjectionFixture {
  runId: string;
  itemId: string;
  logicalKey: string;
  frozenUpdatedAt: string;
  snapshotRevision: string;
  userId?: string;
  currentUpdatedAt?: string;
  status?: "queued" | "running" | "retrying" | "succeeded" | "failed" | "canceled";
  stage?: "queued" | "identifying" | "pricing" | "generating" | "persisting" | "completed";
  attributes?: Record<string, unknown>;
  photos?: string[];
}

export function runHistoryProjectionRow(
  fixture: RunHistoryProjectionFixture,
) {
  const userId = fixture.userId ?? "user_native";
  const currentUpdatedAt = fixture.currentUpdatedAt ?? fixture.frozenUpdatedAt;
  return {
    run_id: fixture.runId,
    logical_idempotency_key: fixture.logicalKey,
    last_meaningful_update_at: fixture.frozenUpdatedAt,
    snapshot_revision: fixture.snapshotRevision,
    run_projection: {
      id: fixture.runId,
      user_id: userId,
      item_id: fixture.itemId,
      listing_id: null,
      status: fixture.status ?? "running",
      stage: fixture.stage ?? "pricing",
      schema_version: 1,
      attempt_count: 1,
      max_attempts: 3,
      safe_failure_message: null,
      created_at: "2026-07-19T18:00:00.000Z",
      updated_at: currentUpdatedAt,
      enqueued_at: "2026-07-19T18:00:01.000Z",
      started_at: "2026-07-19T18:00:10.000Z",
      last_attempted_at: "2026-07-19T18:00:10.000Z",
      next_attempt_at: null,
      completed_at: null,
      retention_cleaned_at: null,
    },
    item_projection: {
      id: fixture.itemId,
      user_id: userId,
      attributes: fixture.attributes ?? { brand: "Canon", model: "AE-1" },
      photos: fixture.photos ?? [`${userId}/items/front.jpg`],
    },
    retry_projection: {
      effective_allowance: "reserved",
      can_retry: false,
    },
  };
}
