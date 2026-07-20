import { describe, expect, it, vi } from "vitest";
import {
  MobileRunConflictError,
  MobileRunNotFoundError,
  MobileRunUnavailableError,
  createMobileRunOperations,
  createSupabaseMobileRunDataClient,
  type MobileRunDataClient,
} from "./runs";

const RUN_ID = "24100000-0000-4000-8000-000000000001";
const ITEM_ID = "24100000-0000-4000-8000-000000000002";

function runRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    user_id: "user_native",
    item_id: ITEM_ID,
    listing_id: null,
    status: "running",
    stage: "pricing",
    schema_version: 1,
    attempt_count: 1,
    max_attempts: 3,
    safe_failure_message: null,
    created_at: "2026-07-19T18:00:00.000Z",
    updated_at: "2026-07-19T18:01:00.000Z",
    enqueued_at: "2026-07-19T18:00:01.000Z",
    started_at: "2026-07-19T18:00:10.000Z",
    last_attempted_at: "2026-07-19T18:00:10.000Z",
    next_attempt_at: null,
    completed_at: null,
    retention_cleaned_at: null,
    ...overrides,
  };
}

function dataClient(overrides: Partial<MobileRunDataClient> = {}): MobileRunDataClient {
  return {
    readRun: vi.fn().mockResolvedValue({ data: runRow(), error: null }),
    readItem: vi.fn().mockResolvedValue({
      data: {
        id: ITEM_ID,
        user_id: "user_native",
        attributes: { brand: "Canon", model: "AE-1" },
        photos: ["user_native/items/front.jpg", "user_native/items/back.jpg"],
      },
      error: null,
    }),
    readReservation: vi.fn().mockResolvedValue({
      data: { state: "reserved" },
      error: null,
    }),
    retryRun: vi.fn().mockResolvedValue({ data: { status: "queued" }, error: null }),
    cancelRun: vi.fn().mockResolvedValue({ data: { status: "canceled" }, error: null }),
    ...overrides,
  };
}

describe("mobile durable-run operations", () => {
  it("maps the authenticated RLS row into the full provider-neutral run detail", async () => {
    const client = {
      readRun: vi.fn().mockResolvedValue({
        data: {
          id: RUN_ID,
          user_id: "user_native",
          item_id: ITEM_ID,
          listing_id: null,
          status: "running",
          stage: "pricing",
          schema_version: 1,
          attempt_count: 1,
          max_attempts: 3,
          safe_failure_message: null,
          created_at: "2026-07-19T18:00:00.000Z",
          updated_at: "2026-07-19T18:01:00.000Z",
          enqueued_at: "2026-07-19T18:00:01.000Z",
          started_at: "2026-07-19T18:00:10.000Z",
          last_attempted_at: "2026-07-19T18:00:10.000Z",
          next_attempt_at: null,
          completed_at: null,
          retention_cleaned_at: null,
        },
        error: null,
      }),
      readItem: vi.fn().mockResolvedValue({
        data: {
          id: ITEM_ID,
          user_id: "user_native",
          attributes: { brand: "Canon", model: "AE-1" },
          photos: ["user_native/items/front.jpg", "user_native/items/back.jpg"],
        },
        error: null,
      }),
      readReservation: vi.fn().mockResolvedValue({
        data: { state: "reserved" },
        error: null,
      }),
      retryRun: vi.fn(),
      cancelRun: vi.fn(),
    };
    const clientForBearer = vi.fn().mockResolvedValue(client);
    const operations = createMobileRunOperations(clientForBearer);

    await expect(
      operations.get({
        runId: RUN_ID,
        userId: "user_native",
        bearerToken: "signed-jwt",
      }),
    ).resolves.toEqual({
      id: RUN_ID,
      itemId: ITEM_ID,
      listingId: null,
      status: "running",
      stage: "pricing",
      attemptCount: 1,
      maxAttempts: 3,
      schemaVersion: 1,
      timestamps: {
        createdAt: "2026-07-19T18:00:00.000Z",
        updatedAt: "2026-07-19T18:01:00.000Z",
        enqueuedAt: "2026-07-19T18:00:01.000Z",
        startedAt: "2026-07-19T18:00:10.000Z",
        lastAttemptedAt: "2026-07-19T18:00:10.000Z",
        nextAttemptAt: null,
        completedAt: null,
        retentionCleanedAt: null,
      },
      item: { title: "Canon AE-1", photoCount: 2 },
      requiredInput: null,
      terminalOutcome: null,
      safeFailure: null,
      allowance: "reserved",
      legalActions: {
        canRetry: false,
        canCancel: true,
        canOpenReview: false,
        canStartNewCapture: false,
      },
      lastMeaningfulUpdateAt: "2026-07-19T18:01:00.000Z",
      retentionCleanedAt: null,
    });
    expect(clientForBearer).toHaveBeenCalledWith("signed-jwt");
    expect(client.readRun).toHaveBeenCalledWith(RUN_ID);
  });

  it.each([
    ["queued", "queued", false, true, null],
    ["running", "identifying", false, true, null],
    ["retrying", "pricing", false, true, null],
    ["succeeded", "completed", false, false, "succeeded"],
    ["failed", "pricing", true, false, "failed"],
    ["canceled", "pricing", true, false, "canceled"],
  ] as const)(
    "maps canonical %s truth without a percentage or ETA",
    async (status, stage, canRetry, canCancel, terminalOutcome) => {
      const listingId = status === "succeeded"
        ? "24100000-0000-4000-8000-000000000005"
        : null;
      const client = dataClient({
        readRun: vi.fn().mockResolvedValue({
          data: runRow({
            status,
            stage,
            listing_id: listingId,
            safe_failure_message: ["retrying", "failed"].includes(status)
              ? "Price research timed out."
              : null,
            completed_at: terminalOutcome ? "2026-07-19T18:02:00.000Z" : null,
          }),
          error: null,
        }),
      });

      const result = await createMobileRunOperations(async () => client).get({
        runId: RUN_ID,
        userId: "user_native",
        bearerToken: "signed-jwt",
      });

      expect(result).toMatchObject({
        status,
        stage,
        terminalOutcome,
        legalActions: { canRetry, canCancel },
      });
      expect(result?.safeFailure).toEqual(
        status === "failed"
          ? {
              reason: "This run couldn’t finish",
              detail: "Price research timed out.",
              retryable: true,
              workPreserved: true,
            }
          : null,
      );
      expect(result).not.toHaveProperty("progress");
      expect(result).not.toHaveProperty("percentage");
      expect(result).not.toHaveProperty("eta");
    },
  );

  it("replays retry and cancel against the same logical run and re-reads canonical truth", async () => {
    let current = runRow({
      status: "failed",
      stage: "pricing",
      safe_failure_message: "Price research timed out.",
      completed_at: "2026-07-19T18:02:00.000Z",
    });
    const client = dataClient({
      readRun: vi.fn(async () => ({ data: current, error: null })),
      retryRun: vi.fn(async () => {
        current = runRow({ status: "queued", stage: "queued", attempt_count: 1 });
        return { data: { runId: RUN_ID, status: "queued" }, error: null };
      }),
      cancelRun: vi.fn(async () => {
        current = runRow({
          status: "canceled",
          stage: "queued",
          completed_at: "2026-07-19T18:03:00.000Z",
        });
        return { data: { runId: RUN_ID, status: "canceled" }, error: null };
      }),
    });
    const operations = createMobileRunOperations(async () => client);
    const retryInput = {
      runId: RUN_ID,
      userId: "user_native",
      bearerToken: "signed-jwt",
      idempotencyKey: "24100000-0000-4000-8000-000000000003",
    };

    const firstRetry = await operations.retry(retryInput);
    const duplicateRetry = await operations.retry(retryInput);
    const canceled = await operations.cancel({
      ...retryInput,
      idempotencyKey: "24100000-0000-4000-8000-000000000004",
    });

    expect(firstRetry.id).toBe(RUN_ID);
    expect(duplicateRetry.id).toBe(RUN_ID);
    expect(canceled).toMatchObject({ id: RUN_ID, status: "canceled" });
    expect(client.retryRun).toHaveBeenCalledTimes(2);
    expect(client.cancelRun).toHaveBeenCalledOnce();
  });

  it("advertises retry after #278 made restored-credit reclaim canonical", async () => {
    const client = dataClient({
      readRun: vi.fn().mockResolvedValue({
        data: runRow({
          status: "failed",
          safe_failure_message: "Price research timed out.",
          completed_at: "2026-07-19T18:02:00.000Z",
        }),
        error: null,
      }),
      readReservation: vi.fn().mockResolvedValue({
        data: { state: "restored" },
        error: null,
      }),
    });

    await expect(
      createMobileRunOperations(async () => client).get({
        runId: RUN_ID,
        userId: "user_native",
        bearerToken: "signed-jwt",
      }),
    ).resolves.toMatchObject({
      allowance: "restored",
      legalActions: { canRetry: true },
      safeFailure: { retryable: true },
    });
  });

  it.each([
    ["P0002", MobileRunNotFoundError],
    ["P0001", MobileRunConflictError],
    ["55000", MobileRunConflictError],
    ["23514", MobileRunConflictError],
    ["XX000", MobileRunUnavailableError],
  ] as const)("maps canonical RPC error %s without leaking its message", async (code, ErrorType) => {
    const client = dataClient({
      retryRun: vi.fn().mockResolvedValue({
        data: null,
        error: { code, message: "private database detail" },
      }),
    });

    await expect(
      createMobileRunOperations(async () => client).retry({
        runId: RUN_ID,
        userId: "user_native",
        bearerToken: "signed-jwt",
        idempotencyKey: "24100000-0000-4000-8000-000000000003",
      }),
    ).rejects.toBeInstanceOf(ErrorType);
  });

  it("maps a durable rejected-operation receipt without re-reading run state", async () => {
    const client = dataClient({
      retryRun: vi.fn().mockResolvedValue({
        data: {
          mobileRunOperationError: {
            code: "55000",
            message: "private database detail",
          },
        },
        error: null,
      }),
    });

    await expect(
      createMobileRunOperations(async () => client).retry({
        runId: RUN_ID,
        userId: "user_native",
        bearerToken: "signed-jwt",
        idempotencyKey: "24100000-0000-4000-8000-000000000003",
      }),
    ).rejects.toBeInstanceOf(MobileRunConflictError);
    expect(client.readRun).not.toHaveBeenCalled();
  });

  it("fails closed when an adapter crosses the verified tenant boundary", async () => {
    const client = dataClient({
      readRun: vi.fn().mockResolvedValue({
        data: runRow({ user_id: "different_tenant" }),
        error: null,
      }),
    });

    await expect(
      createMobileRunOperations(async () => client).get({
        runId: RUN_ID,
        userId: "user_native",
        bearerToken: "signed-jwt",
      }),
    ).rejects.toBeInstanceOf(MobileRunUnavailableError);
  });

  it("uses only the RLS tables and canonical #161 retry/cancel RPC names", async () => {
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      maybeSingle,
    };
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
    const supabase = {
      from: vi.fn(() => query),
      rpc,
    };
    const client = createSupabaseMobileRunDataClient(supabase as never);

    await client.readRun(RUN_ID);
    await client.readItem(ITEM_ID);
    await client.readReservation(RUN_ID);
    const retryKey = "24100000-0000-4000-8000-000000000003";
    const cancelKey = "24100000-0000-4000-8000-000000000004";
    await client.retryRun(RUN_ID, retryKey);
    await client.cancelRun(RUN_ID, cancelKey);

    expect(supabase.from).toHaveBeenNthCalledWith(1, "pipeline_runs");
    expect(supabase.from).toHaveBeenNthCalledWith(2, "items");
    expect(supabase.from).toHaveBeenNthCalledWith(
      3,
      "ai_item_credit_reservations",
    );
    expect(rpc).toHaveBeenNthCalledWith(1, "apply_mobile_run_operation", {
      p_idempotency_key: retryKey,
      p_operation: "retry",
      p_run_id: RUN_ID,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "apply_mobile_run_operation", {
      p_idempotency_key: cancelKey,
      p_operation: "cancel",
      p_run_id: RUN_ID,
    });
  });
});
