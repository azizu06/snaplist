import { describe, expect, it, vi } from "vitest";
import {
  MobileRunConflictError,
  MobileRunInvalidCursorError,
  MobileRunNotFoundError,
  MobileRunUnavailableError,
  createMobileRunOperations,
  createSupabaseMobileRunDataClient,
  type MobileRunDataClient,
} from "./runs";
import { runHistoryProjectionRow } from "./run-history.test-fixtures";

const RUN_ID = "24100000-0000-4000-8000-000000000001";
const ITEM_ID = "24100000-0000-4000-8000-000000000002";
const OLDER_RUN_ID = "24100000-0000-4000-8000-000000000003";
const LOGICAL_KEY = "24100000-0000-4000-8000-000000000004";
const OLDER_LOGICAL_KEY = "24100000-0000-4000-8000-000000000005";
const CURSOR_SIGNING_SECRET = "offline-run-history-cursor-signing-secret";

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
    listRunHistoryPage: vi.fn().mockResolvedValue({ data: [], error: null }),
    readDeliveryProjections: vi.fn().mockResolvedValue({ data: [], error: null }),
    signCoverPhotoUrls: vi.fn().mockResolvedValue(new Map()),
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
    readRetryProjection: vi.fn().mockResolvedValue({
      data: { effective_allowance: "reserved", can_retry: false },
      error: null,
    }),
    retryRun: vi.fn().mockResolvedValue({ data: { status: "queued" }, error: null }),
    cancelRun: vi.fn().mockResolvedValue({ data: { status: "canceled" }, error: null }),
    ...overrides,
  };
}

function mobileRunOperations(
  clientForBearer: Parameters<typeof createMobileRunOperations>[0],
) {
  return createMobileRunOperations(clientForBearer, CURSOR_SIGNING_SECRET);
}

describe("mobile durable-run operations", () => {
  it("continues a frozen tenant run snapshot when an unseen run updates", async () => {
    let olderUpdatedAt = "2026-07-19T17:59:00.000Z";
    const listRunHistoryPage = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          runHistoryProjectionRow({
            runId: RUN_ID,
            itemId: ITEM_ID,
            logicalKey: LOGICAL_KEY,
            frozenUpdatedAt: "2026-07-19T18:01:00.000Z",
            snapshotRevision: "7",
          }),
          runHistoryProjectionRow({
            runId: OLDER_RUN_ID,
            itemId: ITEM_ID,
            logicalKey: OLDER_LOGICAL_KEY,
            frozenUpdatedAt: olderUpdatedAt,
            snapshotRevision: "7",
          }),
        ],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [
          runHistoryProjectionRow({
            runId: OLDER_RUN_ID,
            itemId: ITEM_ID,
            logicalKey: OLDER_LOGICAL_KEY,
            frozenUpdatedAt: "2026-07-19T17:59:00.000Z",
            currentUpdatedAt: "2026-07-19T18:02:00.000Z",
            snapshotRevision: "7",
          }),
        ],
        error: null,
      });
    const client = dataClient({
      readRun: vi.fn(async (runId: string) => ({
        data: runRow(
          runId === OLDER_RUN_ID
            ? { id: runId, updated_at: olderUpdatedAt }
            : { id: runId },
        ),
        error: null,
      })),
    });
    const operations = mobileRunOperations(async () => ({
      ...client,
      listRunHistoryPage,
    }));

    const first = await operations.list({
      userId: "user_native",
      bearerToken: "signed-jwt",
      limit: 1,
    });
    olderUpdatedAt = "2026-07-19T18:02:00.000Z";
    const second = await operations.list({
      userId: "user_native",
      bearerToken: "signed-jwt",
      limit: 1,
      cursor: first.nextCursor!,
    });

    expect([
      ...first.entries.map((entry) => entry.run.id),
      ...second.entries.map((entry) => entry.run.id),
    ]).toEqual([RUN_ID, OLDER_RUN_ID]);
    expect(second.entries[0]?.orderKey).toEqual({
      lastMeaningfulUpdateAt: "2026-07-19T17:59:00.000Z",
      runId: OLDER_RUN_ID,
    });
    expect(second.entries[0]?.logicalIdentity).toEqual({
      idempotencyKey: OLDER_LOGICAL_KEY,
    });
    expect(listRunHistoryPage).toHaveBeenNthCalledWith(1, { limit: 2 });
    expect(listRunHistoryPage).toHaveBeenNthCalledWith(2, {
      limit: 2,
      snapshotRevision: "7",
      before: {
        lastMeaningfulUpdateAt: "2026-07-19T18:01:00.000Z",
        runId: RUN_ID,
      },
    });
    expect(second.nextCursor).toBeNull();
    expect(second.entries[0]?.run.lastMeaningfulUpdateAt).toBe(
      "2026-07-19T18:02:00.000Z",
    );
  });

  it("rejects a run-history cursor issued to another authenticated principal", async () => {
    const listRunHistoryPage = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          runHistoryProjectionRow({
            runId: RUN_ID,
            itemId: ITEM_ID,
            logicalKey: LOGICAL_KEY,
            frozenUpdatedAt: "2026-07-19T18:01:00.000Z",
            snapshotRevision: "7",
          }),
          runHistoryProjectionRow({
            runId: OLDER_RUN_ID,
            itemId: ITEM_ID,
            logicalKey: OLDER_LOGICAL_KEY,
            frozenUpdatedAt: "2026-07-19T17:59:00.000Z",
            snapshotRevision: "7",
          }),
        ],
        error: null,
      })
      .mockResolvedValue({ data: [], error: null });
    const operations = mobileRunOperations(async () => ({
      ...dataClient(),
      listRunHistoryPage,
    }));
    const first = await operations.list({
      userId: "user_native",
      bearerToken: "tenant-a-jwt",
      limit: 1,
    });

    await expect(
      operations.list({
        userId: "tenant_b",
        bearerToken: "tenant-b-jwt",
        limit: 1,
        cursor: first.nextCursor!,
      }),
    ).rejects.toBeInstanceOf(MobileRunInvalidCursorError);

    const [version, encodedPayload, signature] = first.nextCursor!.split(".");
    const payload = JSON.parse(
      Buffer.from(encodedPayload!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const reboundCursor = [
      version,
      Buffer.from(
        JSON.stringify({ ...payload, userId: "tenant_b" }),
      ).toString("base64url"),
      signature,
    ].join(".");
    await expect(
      operations.list({
        userId: "tenant_b",
        bearerToken: "tenant-b-jwt",
        limit: 1,
        cursor: reboundCursor,
      }),
    ).rejects.toBeInstanceOf(MobileRunInvalidCursorError);
    expect(listRunHistoryPage).toHaveBeenCalledTimes(1);
  });

  it("projects the supported 50-row history page without per-entry data calls", async () => {
    const runIds = Array.from(
      { length: 50 },
      (_, index) =>
        `24100000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    );
    const itemIds = Array.from(
      { length: 50 },
      (_, index) =>
        `24200000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    );
    const logicalKeys = Array.from(
      { length: 50 },
      (_, index) =>
        `24300000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`,
    );
    const listRunHistoryPage = vi.fn().mockResolvedValue({
      data: runIds.map((runId, index) =>
        runHistoryProjectionRow({
          runId,
          itemId: itemIds[index]!,
          logicalKey: logicalKeys[index]!,
          frozenUpdatedAt: `2026-07-19T18:00:${String(
            49 - index,
          ).padStart(2, "0")}.000Z`,
          snapshotRevision: "57",
          attributes: { title: `Item ${index}` },
          photos: [`user_native/items/${itemIds[index]}.jpg`],
        })
      ),
      error: null,
    });
    const readRun = vi.fn(async (runId: string) => {
      const index = runIds.indexOf(runId);
      return {
        data: runRow({
          id: runId,
          item_id: itemIds[index],
          updated_at: `2026-07-19T18:00:${String(49 - index).padStart(2, "0")}.000Z`,
        }),
        error: null,
      };
    });
    const readItem = vi.fn(async (itemId: string) => ({
      data: {
        id: itemId,
        user_id: "user_native",
        attributes: { title: `Item ${itemIds.indexOf(itemId)}` },
        photos: [`user_native/items/${itemId}.jpg`],
      },
      error: null,
    }));
    const readRetryProjection = vi.fn().mockResolvedValue({
      data: { effective_allowance: "reserved", can_retry: false },
      error: null,
    });
    const operations = mobileRunOperations(async () =>
      dataClient({
        listRunHistoryPage,
        readRun,
        readItem,
        readRetryProjection,
      })
    );

    const page = await operations.list({
      userId: "user_native",
      bearerToken: "signed-jwt",
      limit: 50,
    });

    expect(page.entries.map((entry) => entry.run.id)).toEqual(runIds);
    expect(page.entries.map((entry) => entry.run.itemId)).toEqual(itemIds);
    expect(
      page.entries.map((entry) => entry.logicalIdentity.idempotencyKey),
    ).toEqual(logicalKeys);
    expect(page.entries.map((entry) => entry.orderKey.runId)).toEqual(runIds);
    expect(page.nextCursor).toBeNull();
    expect(listRunHistoryPage).toHaveBeenCalledExactlyOnceWith({ limit: 51 });
    expect(readRun).not.toHaveBeenCalled();
    expect(readItem).not.toHaveBeenCalled();
    expect(readRetryProjection).not.toHaveBeenCalled();
  });

  it("projects only persisted delivery truth for the tenant history page", async () => {
    const listingId = "24100000-0000-4000-8000-000000000006";
    const baseHistoryRow = runHistoryProjectionRow({
      runId: RUN_ID,
      itemId: ITEM_ID,
      logicalKey: LOGICAL_KEY,
      frozenUpdatedAt: "2026-07-19T18:01:00.000Z",
      snapshotRevision: "7",
      status: "succeeded",
      stage: "completed",
    });
    const historyRow = {
      ...baseHistoryRow,
      run_projection: {
        ...baseHistoryRow.run_projection,
        listing_id: listingId,
        completed_at: "2026-07-19T18:01:00.000Z",
      },
    };
    const listRunHistoryPage = vi.fn().mockResolvedValue({
      data: [historyRow],
      error: null,
    });
    const readDeliveryProjections = vi.fn().mockResolvedValue({
      data: [
        {
          id: listingId,
          user_id: "user_native",
          item_id: ITEM_ID,
          platform: "ebay",
          source_review_revision: null,
          ebay_listing_id: "123456789012",
          ebay_status: "published",
        },
      ],
      error: null,
    });
    const signCoverPhotoUrls = vi.fn().mockResolvedValue(
      new Map([
        [
          "user_native/items/front.jpg",
          "https://media.snaplist.dev/signed/front.jpg",
        ],
      ]),
    );
    const operations = mobileRunOperations(async () =>
      dataClient({
        listRunHistoryPage,
        readDeliveryProjections,
        signCoverPhotoUrls,
      })
    );

    const page = await operations.list({
      userId: "user_native",
      bearerToken: "signed-jwt",
      limit: 20,
    });

    expect(page.entries[0]?.run.delivery).toEqual({
      state: "published_to_ebay",
      coverPhotoUrl: "https://media.snaplist.dev/signed/front.jpg",
    });
    expect(readDeliveryProjections).toHaveBeenCalledExactlyOnceWith([ITEM_ID]);
  });

  it("projects a current assisted pack as prepared without claiming it was shared", async () => {
    const historyRow = runHistoryProjectionRow({
      runId: RUN_ID,
      itemId: ITEM_ID,
      logicalKey: LOGICAL_KEY,
      frozenUpdatedAt: "2026-07-19T18:01:00.000Z",
      snapshotRevision: "7",
      status: "succeeded",
      stage: "completed",
    });
    const operations = mobileRunOperations(async () =>
      dataClient({
        listRunHistoryPage: vi.fn().mockResolvedValue({
          data: [historyRow],
          error: null,
        }),
        readDeliveryProjections: vi.fn().mockResolvedValue({
          data: [
            {
              id: "24100000-0000-4000-8000-000000000007",
              user_id: "user_native",
              item_id: ITEM_ID,
              platform: "mercari",
              source_review_revision:
                "24100000-0000-4000-8000-000000000008",
              ebay_listing_id: null,
              ebay_status: null,
            },
          ],
          error: null,
        }),
      })
    );

    const page = await operations.list({
      userId: "user_native",
      bearerToken: "signed-jwt",
      limit: 20,
    });

    expect(page.entries[0]?.run.delivery).toEqual({
      state: "export_prepared",
    });
    expect(JSON.stringify(page)).not.toContain("shared");
  });

  it("does not promote a withheld Depop pack into settled Trophy Wall truth", async () => {
    const historyRow = runHistoryProjectionRow({
      runId: RUN_ID,
      itemId: ITEM_ID,
      logicalKey: LOGICAL_KEY,
      frozenUpdatedAt: "2026-07-19T18:01:00.000Z",
      snapshotRevision: "7",
      status: "succeeded",
      stage: "completed",
    });
    const operations = mobileRunOperations(async () =>
      dataClient({
        listRunHistoryPage: vi.fn().mockResolvedValue({
          data: [historyRow],
          error: null,
        }),
        readDeliveryProjections: vi.fn().mockResolvedValue({
          data: [
            {
              id: "24100000-0000-4000-8000-000000000007",
              user_id: "user_native",
              item_id: ITEM_ID,
              platform: "depop",
              source_review_revision:
                "24100000-0000-4000-8000-000000000008",
              ebay_listing_id: null,
              ebay_status: null,
            },
          ],
          error: null,
        }),
      })
    );

    const page = await operations.list({
      userId: "user_native",
      bearerToken: "signed-jwt",
      limit: 20,
    });

    expect(page.entries[0]?.run.delivery).toBeUndefined();
  });

  it("fails closed when a delivery projection crosses the tenant boundary", async () => {
    const historyRow = runHistoryProjectionRow({
      runId: RUN_ID,
      itemId: ITEM_ID,
      logicalKey: LOGICAL_KEY,
      frozenUpdatedAt: "2026-07-19T18:01:00.000Z",
      snapshotRevision: "7",
    });
    const operations = mobileRunOperations(async () =>
      dataClient({
        listRunHistoryPage: vi.fn().mockResolvedValue({
          data: [historyRow],
          error: null,
        }),
        readDeliveryProjections: vi.fn().mockResolvedValue({
          data: [
            {
              id: "24100000-0000-4000-8000-000000000007",
              user_id: "another_tenant",
              item_id: ITEM_ID,
              platform: "depop",
              source_review_revision:
                "24100000-0000-4000-8000-000000000008",
              ebay_listing_id: null,
              ebay_status: null,
            },
          ],
          error: null,
        }),
      })
    );

    await expect(
      operations.list({
        userId: "user_native",
        bearerToken: "signed-jwt",
        limit: 20,
      }),
    ).rejects.toBeInstanceOf(MobileRunUnavailableError);
  });

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
      readRetryProjection: vi.fn().mockResolvedValue({
        data: { effective_allowance: "reserved", can_retry: false },
        error: null,
      }),
      retryRun: vi.fn(),
      cancelRun: vi.fn(),
    };
    const clientForBearer = vi.fn().mockResolvedValue(client);
    const operations = mobileRunOperations(clientForBearer);

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

  it("withholds Review capability until a succeeded listing has a coherent review contract", async () => {
    const listingId = "24100000-0000-4000-8000-000000000005";
    const client = dataClient({
      readRun: vi.fn().mockResolvedValue({
        data: runRow({
          listing_id: listingId,
          status: "succeeded",
          stage: "completed",
          completed_at: "2026-07-19T18:02:00.000Z",
        }),
        error: null,
      }),
      readRetryProjection: vi.fn().mockResolvedValue({
        data: { effective_allowance: "settled", can_retry: false },
        error: null,
      }),
    });

    const result = await mobileRunOperations(async () => client).get({
      runId: RUN_ID,
      userId: "user_native",
      bearerToken: "signed-jwt",
    });

    expect(result).toMatchObject({
      listingId,
      status: "succeeded",
      terminalOutcome: "succeeded",
      legalActions: {
        canOpenReview: false,
      },
    });
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
        readRetryProjection: vi.fn().mockResolvedValue({
          data: {
            effective_allowance: canRetry ? "restored" : "reserved",
            can_retry: canRetry,
          },
          error: null,
        }),
      });

      const result = await mobileRunOperations(async () => client).get({
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
    const operations = mobileRunOperations(async () => client);
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

  it.each([
    ["active reclaim", "reserved", false],
    ["exhausted capacity", "restored", false],
    ["eligible restored credit", "restored", true],
  ] as const)(
    "uses the canonical #291 projection for %s",
    async (_scenario, effectiveAllowance, canRetry) => {
      const client = dataClient({
        readRun: vi.fn().mockResolvedValue({
          data: runRow({
            status: "failed",
            safe_failure_message: "Price research timed out.",
            completed_at: "2026-07-19T18:02:00.000Z",
          }),
          error: null,
        }),
        readRetryProjection: vi.fn().mockResolvedValue({
          data: {
            effective_allowance: effectiveAllowance,
            can_retry: canRetry,
          },
          error: null,
        }),
      });

      await expect(
        mobileRunOperations(async () => client).get({
          runId: RUN_ID,
          userId: "user_native",
          bearerToken: "signed-jwt",
        }),
      ).resolves.toMatchObject({
        allowance: effectiveAllowance,
        legalActions: { canRetry },
        safeFailure: { retryable: canRetry },
      });
    },
  );

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
      mobileRunOperations(async () => client).retry({
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
      mobileRunOperations(async () => client).retry({
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
      mobileRunOperations(async () => client).get({
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
      in: vi.fn(() => query),
      maybeSingle,
    };
    const projectionMaybeSingle = vi.fn().mockResolvedValue({
      data: { effective_allowance: "reserved", can_retry: false },
      error: null,
    });
    const rpc = vi.fn((name: string) =>
      name === "get_pipeline_run_retry_projection"
        ? { maybeSingle: projectionMaybeSingle }
        : Promise.resolve({ data: {}, error: null })
    );
    const supabase = {
      from: vi.fn(() => query),
      rpc,
    };
    const client = createSupabaseMobileRunDataClient(supabase as never);

    await client.readRun(RUN_ID);
    await client.readItem(ITEM_ID);
    await client.readDeliveryProjections([ITEM_ID]);
    await client.readRetryProjection(RUN_ID);
    const retryKey = "24100000-0000-4000-8000-000000000003";
    const cancelKey = "24100000-0000-4000-8000-000000000004";
    await client.retryRun(RUN_ID, retryKey);
    await client.cancelRun(RUN_ID, cancelKey);

    expect(supabase.from).toHaveBeenNthCalledWith(1, "pipeline_runs");
    expect(supabase.from).toHaveBeenNthCalledWith(2, "items");
    expect(supabase.from).toHaveBeenNthCalledWith(3, "listings");
    expect(query.in).toHaveBeenCalledWith("item_id", [ITEM_ID]);
    expect(rpc).toHaveBeenNthCalledWith(1, "get_pipeline_run_retry_projection", {
      p_run_id: RUN_ID,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "apply_mobile_run_operation", {
      p_idempotency_key: retryKey,
      p_operation: "retry",
      p_run_id: RUN_ID,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, "apply_mobile_run_operation", {
      p_idempotency_key: cancelKey,
      p_operation: "cancel",
      p_run_id: RUN_ID,
    });
  });
});
