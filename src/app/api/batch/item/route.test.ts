import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUserId: vi.fn(),
  resolveNewAiItemRunPolicy: vi.fn(),
  enforceRateLimit: vi.fn(),
  checkDailyItemQuota: vi.fn(),
  recordPipelineRunAndMaybeAlert: vi.fn(),
  refundDailyItem: vi.fn(),
  createVisionPipeline: vi.fn(),
  runPipelineAndPersist: vi.fn(),
  getAutopilotEnabled: vi.fn(),
  logServerError: vi.fn(),
  serverErrorJson: vi.fn(),
  createStore: vi.fn(),
  tierLimits: vi.fn(() => ({ itemsPerDay: 15, meteredPerMinute: 20 })),
}));

const upload = vi.fn(async () => ({ error: null }));
const remove = vi.fn(async () => ({ error: null }));
const supabase = {
  storage: { from: vi.fn(() => ({ upload, remove })) },
};
const usageStore = {
  reserveLegacyUsage: vi.fn(),
  releaseLegacyDailyReservation: vi.fn(),
};

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ getUserId: mocks.getUserId }));
vi.mock("@/lib/billing", () => ({
  resolveNewAiItemRunPolicy: mocks.resolveNewAiItemRunPolicy,
}));
vi.mock("@/lib/abuse", () => ({
  enforceRateLimit: mocks.enforceRateLimit,
  checkDailyItemQuota: mocks.checkDailyItemQuota,
  recordPipelineRunAndMaybeAlert: mocks.recordPipelineRunAndMaybeAlert,
  refundDailyItem: mocks.refundDailyItem,
  tierLimits: mocks.tierLimits,
}));
vi.mock("@/lib/pipeline-staging/internal", () => ({
  createInternalPipelineStagingStore: mocks.createStore,
}));
vi.mock("@/lib/pipeline", () => ({
  initialListingStatus: vi.fn(() => "draft"),
  runPipelineAndPersist: mocks.runPipelineAndPersist,
}));
vi.mock("@/lib/vision", () => ({ createVisionPipeline: mocks.createVisionPipeline }));
vi.mock("@/lib/settings/user-settings", () => ({
  getAutopilotEnabled: mocks.getAutopilotEnabled,
}));
vi.mock("@/lib/api/errors", () => ({
  logServerError: mocks.logServerError,
  serverErrorJson: mocks.serverErrorJson,
}));

import { POST } from "./route";

function validRequest(): Request {
  const form = new FormData();
  form.set("photo", new File(["image"], "item.jpg", { type: "image/jpeg" }));
  return new Request("https://snaplist.test/api/batch/item", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue(supabase);
  mocks.getUserId.mockResolvedValue("tenant-a");
  mocks.enforceRateLimit.mockResolvedValue(null);
  mocks.checkDailyItemQuota.mockResolvedValue({ allowed: true, used: 1, limit: 7 });
  mocks.createStore.mockReturnValue(usageStore);
  usageStore.reserveLegacyUsage.mockResolvedValue(true);
  usageStore.releaseLegacyDailyReservation.mockResolvedValue(true);
  mocks.getAutopilotEnabled.mockResolvedValue(false);
  mocks.createVisionPipeline.mockReturnValue({ run: vi.fn() });
  mocks.runPipelineAndPersist.mockResolvedValue({
    itemId: "item-1",
    listingId: "listing-1",
    result: { confidence: { score: 0.5 } },
  });
});

describe("POST /api/batch/item new AI-item authorization", () => {
  it("returns a Pro-required result before storage or provider work for a free second run", async () => {
    mocks.resolveNewAiItemRunPolicy.mockResolvedValue({
      allowed: false,
      reason: "snaplist-pro-required",
      entitlement: "free",
      hasCompletedAiItemRun: true,
    });

    const response = await POST(validRequest());
    const body = await response.json();

    expect(response.status).toBe(403);
    expect(body).toMatchObject({
      kind: "quota",
      reason: "snaplist-pro-required",
    });
    expect(body.error).toMatch(/SnapList Pro/i);
    expect(mocks.resolveNewAiItemRunPolicy).toHaveBeenCalledWith("tenant-a", {
      client: supabase,
    });
    expect(mocks.checkDailyItemQuota).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(mocks.createVisionPipeline).not.toHaveBeenCalled();
  });

  it("fails closed with a retryable response when the policy cannot be resolved", async () => {
    mocks.resolveNewAiItemRunPolicy.mockResolvedValue({
      allowed: false,
      reason: "policy-unavailable",
      entitlement: "free",
      hasCompletedAiItemRun: null,
    });

    const response = await POST(validRequest());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: "We couldn't verify whether this item can start. Please try again.",
      kind: "policy-unavailable",
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it("keeps an operational daily guardrail independent of plan entitlement", async () => {
    mocks.resolveNewAiItemRunPolicy.mockResolvedValue({
      allowed: true,
      reason: "included-first-run",
      entitlement: "free",
      hasCompletedAiItemRun: false,
    });
    mocks.checkDailyItemQuota.mockResolvedValue({ allowed: false, used: 8, limit: 7 });

    const response = await POST(validRequest());
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(mocks.checkDailyItemQuota).toHaveBeenCalledWith("tenant-a");
    expect(body).toEqual({
      error: "Capacity limit reached. Please try again later.",
      kind: "quota",
    });
    expect(JSON.stringify(body)).not.toMatch(/free|paid|pro|items\/day|\b7\b/i);
  });

  it("adds a durable reservation to the legacy request before provider work", async () => {
    mocks.resolveNewAiItemRunPolicy.mockResolvedValue({
      allowed: true,
      reason: "included-first-run",
      entitlement: "free",
      hasCompletedAiItemRun: false,
    });

    const response = await POST(validRequest());

    expect(response.status).toBe(200);
    expect(usageStore.reserveLegacyUsage).toHaveBeenCalledWith({
      reservationId: expect.any(String),
      userId: "tenant-a",
      dailyLimit: 7,
      perMinuteLimit: 20,
    });
    expect(upload).toHaveBeenCalledOnce();
    expect(mocks.runPipelineAndPersist).toHaveBeenCalledOnce();
    expect(usageStore.releaseLegacyDailyReservation).not.toHaveBeenCalled();
  });

  it("releases durable daily capacity when legacy provider work fails", async () => {
    mocks.resolveNewAiItemRunPolicy.mockResolvedValue({
      allowed: true,
      reason: "included-first-run",
      entitlement: "free",
      hasCompletedAiItemRun: false,
    });
    mocks.runPipelineAndPersist.mockRejectedValueOnce(new Error("provider failed"));
    mocks.serverErrorJson.mockReturnValueOnce(
      new Response(JSON.stringify({ error: "retry" }), { status: 500 }),
    );

    const response = await POST(validRequest());

    expect(response.status).toBe(500);
    expect(usageStore.releaseLegacyDailyReservation).toHaveBeenCalledWith(
      expect.any(String),
    );
    expect(mocks.refundDailyItem).toHaveBeenCalledWith("tenant-a");
  });

  it("maps shared durable capacity denial without touching storage", async () => {
    mocks.resolveNewAiItemRunPolicy.mockResolvedValue({
      allowed: true,
      reason: "snaplist-pro",
      entitlement: "paid",
      hasCompletedAiItemRun: true,
    });
    usageStore.reserveLegacyUsage.mockRejectedValueOnce(
      new Error("Pipeline daily capacity reached"),
    );

    const response = await POST(validRequest());

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "Capacity limit reached. Please try again later.",
      kind: "quota",
    });
    expect(mocks.refundDailyItem).toHaveBeenCalledWith("tenant-a");
    expect(upload).not.toHaveBeenCalled();
  });

  it("maps shared durable per-minute denial without touching storage", async () => {
    mocks.resolveNewAiItemRunPolicy.mockResolvedValue({
      allowed: true,
      reason: "snaplist-pro",
      entitlement: "paid",
      hasCompletedAiItemRun: true,
    });
    usageStore.reserveLegacyUsage.mockRejectedValueOnce(
      new Error("Pipeline per-minute capacity reached"),
    );

    const response = await POST(validRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: "Too many requests. Please slow down and try again shortly.",
      kind: "rate-limit",
    });
    expect(mocks.refundDailyItem).toHaveBeenCalledWith("tenant-a");
    expect(upload).not.toHaveBeenCalled();
  });
});
