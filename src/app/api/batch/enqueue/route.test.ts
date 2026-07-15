import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUserId: vi.fn(),
  resolveSellerPolicy: vi.fn(),
  getAutopilotEnabled: vi.fn(),
  createStore: vi.fn(),
  stageUploadEntries: vi.fn(),
  parseCostBasis: vi.fn((value) => value == null ? null : Number(value)),
  logServerError: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ getUserId: mocks.getUserId }));
vi.mock("@/lib/billing", () => ({ resolveSellerPolicy: mocks.resolveSellerPolicy }));
vi.mock("@/lib/settings/user-settings", () => ({ getAutopilotEnabled: mocks.getAutopilotEnabled }));
vi.mock("@/lib/pipeline-staging/internal", () => ({ createInternalPipelineStagingStore: mocks.createStore }));
vi.mock("@/lib/upload-staging", () => ({ stageUploadEntries: mocks.stageUploadEntries }));
vi.mock("@/lib/pipeline/autopilot", () => ({ parseCostBasis: mocks.parseCostBasis }));
vi.mock("@/lib/api/errors", () => ({ logServerError: mocks.logServerError }));

import { POST } from "./route";

describe("POST /api/batch/enqueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getUserId.mockResolvedValue("user_123");
    mocks.createClient.mockResolvedValue({ storage: { from: vi.fn() } });
    mocks.resolveSellerPolicy.mockResolvedValue({
      tier: "paid",
      limits: { itemsPerDay: 200, meteredPerMinute: 60 },
    });
    mocks.getAutopilotEnabled.mockResolvedValue(true);
    mocks.createStore.mockReturnValue({ stageAndEnqueue: vi.fn() });
    mocks.stageUploadEntries.mockResolvedValue([
      {
        batch_id: "11111111-1111-4111-8111-111111111111",
        idempotency_key: "item-1",
        item_id: "22222222-2222-4222-8222-222222222222",
        run_id: "33333333-3333-4333-8333-333333333333",
        queue_message_id: "9",
      },
    ]);
  });

  it("stages the whole accepted batch with the shared Seller policy limits", async () => {
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
    expect(mocks.stageUploadEntries).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user_123",
        dailyLimit: 200,
        perMinuteLimit: 60,
        entries: [expect.objectContaining({ source: "batch", costBasis: 5 })],
      }),
      expect.any(Object),
    );
    await expect(response.json()).resolves.toMatchObject({
      batchId: "11111111-1111-4111-8111-111111111111",
      runs: [{ id: "33333333-3333-4333-8333-333333333333", status: "queued" }],
    });
  });
});
