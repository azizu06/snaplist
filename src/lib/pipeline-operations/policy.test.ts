import { describe, expect, it } from "vitest";
import {
  PIPELINE_OPERATIONS_POLICY,
  SUPABASE_FREE_PLAN_ALLOWANCES,
  estimateSupabaseFreePlanUsage,
} from "./policy";

describe("durable pipeline operating policy", () => {
  it("keeps worker concurrency, visibility, attempts, and retry delay bounded", () => {
    expect(PIPELINE_OPERATIONS_POLICY.worker).toEqual({
      batchSize: 1,
      cadenceMinutes: 1,
      maxConcurrentInvocations: 5,
      maxAttempts: 3,
      maxDurationSeconds: 300,
      retryBaseSeconds: 30,
      retryMaxSeconds: 900,
      visibilityTimeoutSeconds: 300,
    });
    expect(PIPELINE_OPERATIONS_POLICY.maintenance).toMatchObject({
      batchSize: 25,
      cadenceMinutes: 60,
      maxDurationSeconds: 300,
    });
  });

  it("accounts for every Supabase Free-plan meter without pretending compute is free", () => {
    const usage = estimateSupabaseFreePlanUsage({
      days: 31,
      averagePhotosPerRun: 4,
      averagePhotoBytes: 2_000_000,
      runs: 100,
    });

    expect(usage).toEqual(expect.objectContaining({
      databaseRows: expect.any(Number),
      databaseBytes: expect.any(Number),
      storageBytes: 800_000_000,
      egressBytes: 800_000_000,
      scheduledInvocations: 45_384,
      computeIsMeteredSeparately: true,
    }));
    expect(usage.storageBytes).toBeLessThan(SUPABASE_FREE_PLAN_ALLOWANCES.storageBytes);
    expect(usage.egressBytes).toBeLessThan(SUPABASE_FREE_PLAN_ALLOWANCES.egressBytes);
    expect(usage.scheduledInvocations).toBeLessThan(
      SUPABASE_FREE_PLAN_ALLOWANCES.edgeFunctionInvocations,
    );
  });
});
