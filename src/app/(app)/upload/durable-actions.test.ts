import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  createClient: vi.fn(),
  getUserId: vi.fn(),
  getAutopilotEnabled: vi.fn(),
  parseCostBasis: vi.fn(() => 12.5),
  tierLimits: vi.fn(() => ({ itemsPerDay: 15, meteredPerMinute: 20 })),
  createStore: vi.fn(),
  stageUploadEntries: vi.fn(),
  reportServerError: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ getUserId: mocks.getUserId }));
vi.mock("@/lib/settings/user-settings", () => ({
  getAutopilotEnabled: mocks.getAutopilotEnabled,
}));
vi.mock("@/lib/pipeline/autopilot", () => ({ parseCostBasis: mocks.parseCostBasis }));
vi.mock("@/lib/abuse", () => ({ tierLimits: mocks.tierLimits }));
vi.mock("@/lib/pipeline-staging/internal", () => ({
  createInternalPipelineStagingStore: mocks.createStore,
}));
vi.mock("@/lib/upload-staging", () => ({ stageUploadEntries: mocks.stageUploadEntries }));
vi.mock("@/lib/sentry", () => ({ reportServerError: mocks.reportServerError }));

import { enqueueUpload } from "./durable-actions";

function uploadForm(): FormData {
  const form = new FormData();
  form.append("photo", new File(["front"], "front.jpg", { type: "image/jpeg" }));
  form.append("photo", new File(["back"], "back.jpg", { type: "image/jpeg" }));
  form.set("idempotencyKey", "single-capture-1");
  form.set("batchId", "11111111-1111-4111-8111-111111111111");
  form.set("costBasis", "12.50");
  return form;
}

describe("enqueueUpload", () => {
  const storage = {
    from: vi.fn(() => ({
      upload: vi.fn(async () => ({ error: null })),
      remove: vi.fn(async () => ({ error: null })),
    })),
  };
  const supabase = { storage };
  const store = { findReplay: vi.fn(), stageAndEnqueue: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue(supabase);
    mocks.getUserId.mockResolvedValue("user_123");
    mocks.getAutopilotEnabled.mockResolvedValue(false);
    mocks.createStore.mockReturnValue(store);
    store.findReplay.mockResolvedValue([]);
    mocks.stageUploadEntries.mockResolvedValue([
      {
        batch_id: "11111111-1111-4111-8111-111111111111",
        batch_position: 0,
        idempotency_key: "single-capture-1",
        item_id: "22222222-2222-4222-8222-222222222222",
        run_id: "33333333-3333-4333-8333-333333333333",
        queue_message_id: "42",
        listing_id: null,
        status: "queued",
        stage: "queued",
        attempt_count: 0,
        max_attempts: 3,
        safe_failure_message: null,
        updated_at: "2026-07-15T12:00:00.000Z",
      },
    ]);
  });

  it("uses operational limits and returns after durable enqueue", async () => {
    await expect(enqueueUpload(uploadForm())).rejects.toThrow(
      "REDIRECT:/review/22222222-2222-4222-8222-222222222222?new=1",
    );

    expect(mocks.tierLimits).toHaveBeenCalledWith("free");
    expect(mocks.stageUploadEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        dailyLimit: 15,
        perMinuteLimit: 20,
        entries: [
          expect.objectContaining({
            idempotencyKey: "single-capture-1",
            source: "single",
            autopilotEnabled: false,
            costBasis: 12.5,
            photos: expect.arrayContaining([expect.any(File), expect.any(File)]),
          }),
        ],
      }),
      expect.objectContaining({ stageAndEnqueue: store.stageAndEnqueue }),
    );
  });

  it("recovers the existing run when the committed enqueue response was lost", async () => {
    store.findReplay.mockResolvedValueOnce([
      {
        batch_id: "11111111-1111-4111-8111-111111111111",
        batch_position: 0,
        idempotency_key: "single-capture-1",
        item_id: "22222222-2222-4222-8222-222222222222",
        run_id: "33333333-3333-4333-8333-333333333333",
        queue_message_id: "42",
        listing_id: null,
        status: "queued",
        stage: "queued",
        attempt_count: 0,
        max_attempts: 3,
        safe_failure_message: null,
        updated_at: "2026-07-15T12:00:00.000Z",
      },
    ]);

    await expect(enqueueUpload(uploadForm())).rejects.toThrow(
      "REDIRECT:/review/22222222-2222-4222-8222-222222222222?new=1",
    );

    expect(store.findReplay).toHaveBeenCalledWith(expect.objectContaining({
      batchId: "11111111-1111-4111-8111-111111111111",
      entries: [expect.objectContaining({
        idempotencyKey: "single-capture-1",
        photoCount: 2,
      })],
    }));
    expect(mocks.stageUploadEntries).not.toHaveBeenCalled();
  });

  it("maps the atomic ledger's Pro-required rejection", async () => {
    mocks.stageUploadEntries.mockRejectedValueOnce(
      new Error(
        "Pipeline staging failed: AI item credit unavailable: snaplist-pro-required",
      ),
    );

    await expect(enqueueUpload(uploadForm())).rejects.toThrow(
      /SnapList\+Pro\+is\+required/i,
    );
    expect(mocks.redirect).toHaveBeenCalledWith(expect.stringContaining(
      "batch=11111111-1111-4111-8111-111111111111",
    ));

    expect(mocks.stageUploadEntries).toHaveBeenCalledOnce();
  });

  it("fails closed when the verified StoreKit period is unavailable", async () => {
    mocks.stageUploadEntries.mockRejectedValueOnce(
      new Error(
        "Pipeline staging failed: AI item credit unavailable: storekit-entitlement-unavailable",
      ),
    );

    await expect(enqueueUpload(uploadForm())).rejects.toThrow(
      /couldn%27t\+verify\+an\+active\+subscription\+period/i,
    );
    expect(mocks.redirect).toHaveBeenCalledWith(expect.stringContaining(
      "batch=11111111-1111-4111-8111-111111111111",
    ));

    expect(mocks.stageUploadEntries).toHaveBeenCalledOnce();
  });

  it("tells a browser seller the included first item is verified in the iOS app", async () => {
    mocks.stageUploadEntries.mockRejectedValueOnce(
      new Error(
        "Pipeline staging failed: AI item credit unavailable: device-fence-required",
      ),
    );

    // #524 fences the included first AI item to one physical Apple device, and
    // only the iOS app can produce that proof. Falling through to the generic
    // "please try again" would invite this seller to retry a request that can
    // never succeed on this surface.
    await expect(enqueueUpload(uploadForm())).rejects.toThrow(
      /verified\+in\+the\+SnapList\+iOS\+app/i,
    );
    expect(mocks.redirect).toHaveBeenCalledWith(expect.stringContaining(
      "batch=11111111-1111-4111-8111-111111111111",
    ));

    expect(mocks.stageUploadEntries).toHaveBeenCalledOnce();
  });

  it("reports an exhausted monthly allowance separately from abuse capacity", async () => {
    mocks.stageUploadEntries.mockRejectedValueOnce(
      new Error(
        "Pipeline staging failed: AI item credit unavailable: monthly-allowance-reached",
      ),
    );

    await expect(enqueueUpload(uploadForm())).rejects.toThrow(
      /subscription\+period%27s\+AI-item\+allowance/i,
    );
    expect(mocks.stageUploadEntries).toHaveBeenCalledOnce();
  });

  it("does not run the request-bound model pipeline", async () => {
    await expect(enqueueUpload(uploadForm())).rejects.toThrow(/REDIRECT:/);
    expect(mocks.stageUploadEntries).toHaveBeenCalledOnce();
  });
});
