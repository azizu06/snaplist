import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUserId: vi.fn(),
  resolveNewAiItemRunPolicy: vi.fn(),
  tierLimits: vi.fn(() => ({ itemsPerDay: 15, meteredPerMinute: 20 })),
  getAutopilotEnabled: vi.fn(),
  createStore: vi.fn(),
  stageUploadEntries: vi.fn(),
  parseCostBasis: vi.fn((value) => value == null ? null : Number(value)),
  logServerError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ getUserId: mocks.getUserId }));
vi.mock("@/lib/billing", () => ({
  resolveNewAiItemRunPolicy: mocks.resolveNewAiItemRunPolicy,
}));
vi.mock("@/lib/abuse", () => ({ tierLimits: mocks.tierLimits }));
vi.mock("@/lib/settings/user-settings", () => ({ getAutopilotEnabled: mocks.getAutopilotEnabled }));
vi.mock("@/lib/pipeline-staging/internal", () => ({ createInternalPipelineStagingStore: mocks.createStore }));
vi.mock("@/lib/upload-staging", () => ({ stageUploadEntries: mocks.stageUploadEntries }));
vi.mock("@/lib/pipeline/autopilot", () => ({ parseCostBasis: mocks.parseCostBasis }));
vi.mock("@/lib/api/errors", () => ({ logServerError: mocks.logServerError }));

import { POST } from "./route";

describe("POST /api/batch/enqueue", () => {
  const store = { findReplay: vi.fn(), stageAndEnqueue: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue("user_123");
    mocks.createClient.mockResolvedValue({ storage: { from: vi.fn() } });
    mocks.resolveNewAiItemRunPolicy.mockResolvedValue({
      allowed: true,
      reason: "snaplist-pro",
      entitlement: "paid",
      hasCompletedAiItemRun: true,
    });
    mocks.getAutopilotEnabled.mockResolvedValue(true);
    store.findReplay.mockResolvedValue([]);
    mocks.createStore.mockReturnValue(store);
    mocks.stageUploadEntries.mockResolvedValue([
      {
        batch_id: "11111111-1111-4111-8111-111111111111",
        batch_position: 0,
        idempotency_key: "item-1",
        item_id: "22222222-2222-4222-8222-222222222222",
        run_id: "33333333-3333-4333-8333-333333333333",
        queue_message_id: "9",
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

  it("stages the whole accepted batch with operational limits", async () => {
    const form = new FormData();
    form.set("manifest", JSON.stringify({
      batchId: "11111111-1111-4111-8111-111111111111",
      entries: [{ idempotencyKey: "item-1", costBasis: "5", photoCount: 1 }],
    }));
    form.append("photo:0", new File(["photo"], "item.jpg", { type: "image/jpeg" }));

    const response = await POST(new Request("https://snaplist.test/api/batch/enqueue", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(202);
    expect(mocks.resolveNewAiItemRunPolicy).toHaveBeenCalledWith("user_123", {
      client: expect.any(Object),
    });
    expect(mocks.stageUploadEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        dailyLimit: 15,
        perMinuteLimit: 20,
        entries: [expect.objectContaining({ source: "batch", costBasis: 5 })],
      }),
      expect.any(Object),
    );
    await expect(response.json()).resolves.toMatchObject({
      batchId: "11111111-1111-4111-8111-111111111111",
      runs: [{ id: "33333333-3333-4333-8333-333333333333", status: "queued" }],
    });
  });

  it("returns the committed batch without uploading again after a lost response", async () => {
    store.findReplay.mockResolvedValueOnce([
      {
        batch_id: "11111111-1111-4111-8111-111111111111",
        batch_position: 0,
        idempotency_key: "item-1",
        item_id: "22222222-2222-4222-8222-222222222222",
        run_id: "33333333-3333-4333-8333-333333333333",
        queue_message_id: "9",
        listing_id: null,
        status: "retrying",
        stage: "pricing",
        attempt_count: 2,
        max_attempts: 3,
        safe_failure_message: null,
        updated_at: "2026-07-15T12:05:00.000Z",
      },
    ]);
    const form = new FormData();
    form.set("manifest", JSON.stringify({
      batchId: "11111111-1111-4111-8111-111111111111",
      entries: [{ idempotencyKey: "item-1", costBasis: "5", photoCount: 1 }],
    }));
    form.append("photo:0", new File(["photo"], "item.jpg", { type: "image/jpeg" }));

    const response = await POST(new Request("https://snaplist.test/api/batch/enqueue", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(200);
    expect(mocks.stageUploadEntries).not.toHaveBeenCalled();
    expect(mocks.resolveNewAiItemRunPolicy).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      runs: [{
        id: "33333333-3333-4333-8333-333333333333",
        status: "retrying",
        updatedAt: "2026-07-15T12:05:00.000Z",
      }],
    });
  });

  it("returns an actionable validation error for a malformed cost basis", async () => {
    mocks.parseCostBasis.mockImplementationOnce(() => {
      throw new Error("Cost basis must be a plain decimal amount");
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify({
      batchId: "11111111-1111-4111-8111-111111111111",
      entries: [{ idempotencyKey: "item-1", costBasis: "$12", photoCount: 1 }],
    }));
    form.append("photo:0", new File(["photo"], "item.jpg", { type: "image/jpeg" }));

    const response = await POST(new Request("https://snaplist.test/api/batch/enqueue", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "What did you pay must be a plain dollar amount or left blank.",
      kind: "validation",
    });
    expect(mocks.logServerError).not.toHaveBeenCalled();
    expect(mocks.stageUploadEntries).not.toHaveBeenCalled();
  });

  it("preserves the merged Pro gate for a free seller's second durable run", async () => {
    mocks.resolveNewAiItemRunPolicy.mockResolvedValueOnce({
      allowed: false,
      reason: "snaplist-pro-required",
      entitlement: "free",
      hasCompletedAiItemRun: true,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify({
      batchId: "11111111-1111-4111-8111-111111111111",
      entries: [{ idempotencyKey: "item-1", costBasis: "5", photoCount: 1 }],
    }));
    form.append("photo:0", new File(["photo"], "item.jpg", { type: "image/jpeg" }));

    const response = await POST(new Request("https://snaplist.test/api/batch/enqueue", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "SnapList Pro is required to start another new item.",
      kind: "quota",
      reason: "snaplist-pro-required",
    });
    expect(mocks.stageUploadEntries).not.toHaveBeenCalled();
  });

  it("allows only the included first item in a free durable batch", async () => {
    mocks.resolveNewAiItemRunPolicy.mockResolvedValueOnce({
      allowed: true,
      reason: "included-first-run",
      entitlement: "free",
      hasCompletedAiItemRun: false,
    });
    const form = new FormData();
    form.set("manifest", JSON.stringify({
      batchId: "11111111-1111-4111-8111-111111111111",
      entries: [
        { idempotencyKey: "item-1", costBasis: "5", photoCount: 1 },
        { idempotencyKey: "item-2", costBasis: "6", photoCount: 1 },
      ],
    }));
    form.append("photo:0", new File(["one"], "one.jpg", { type: "image/jpeg" }));
    form.append("photo:1", new File(["two"], "two.jpg", { type: "image/jpeg" }));

    const response = await POST(new Request("https://snaplist.test/api/batch/enqueue", {
      method: "POST",
      body: form,
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      kind: "quota",
      reason: "snaplist-pro-required",
    });
    expect(mocks.stageUploadEntries).not.toHaveBeenCalled();
  });
});
