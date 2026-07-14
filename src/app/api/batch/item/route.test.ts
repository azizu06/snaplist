import { beforeEach, describe, expect, it, vi } from "vitest";
import { sellerPolicyForTier, type SellerPolicy } from "@/lib/billing/policy";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  getUserId: vi.fn(),
  enforceRateLimit: vi.fn(),
  checkDailyItemQuota: vi.fn(),
  recordPipelineRunAndMaybeAlert: vi.fn(),
  refundDailyItem: vi.fn(),
  resolveSellerPolicy: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ getUserId: mocks.getUserId }));
vi.mock("@/lib/pipeline", () => ({
  initialListingStatus: vi.fn(),
  runPipelineAndPersist: vi.fn(),
}));
vi.mock("@/lib/vision", () => ({ createVisionPipeline: vi.fn() }));
vi.mock("@/lib/settings/user-settings", () => ({ getAutopilotEnabled: vi.fn() }));
vi.mock("@/lib/api/errors", () => ({ logServerError: vi.fn(), serverErrorJson: vi.fn() }));
vi.mock("@/lib/abuse", () => ({
  checkDailyItemQuota: mocks.checkDailyItemQuota,
  enforceRateLimit: mocks.enforceRateLimit,
  recordPipelineRunAndMaybeAlert: mocks.recordPipelineRunAndMaybeAlert,
  refundDailyItem: mocks.refundDailyItem,
}));
vi.mock("@/lib/billing", () => ({ resolveSellerPolicy: mocks.resolveSellerPolicy }));

import { POST } from "./route";

describe("POST /api/batch/item Seller policy enforcement (#153)", () => {
  const supabase = {};
  const request = new Request("https://snaplist.test/api/batch/item", { method: "POST" });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue(supabase);
    mocks.getUserId.mockResolvedValue("seller-1");
    mocks.enforceRateLimit.mockResolvedValue(
      new Response(JSON.stringify({ error: "Too many requests." }), {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    );
  });

  it.each([
    ["free", sellerPolicyForTier("free")],
    ["paid", sellerPolicyForTier("paid")],
    ["missing", sellerPolicyForTier("free")],
    ["canceled", sellerPolicyForTier("free")],
    ["cross-tenant", sellerPolicyForTier("free")],
  ] as const)(
    "passes the resolved %s policy into the route guard before processing a batch item",
    async (_state, policy: SellerPolicy) => {
      mocks.resolveSellerPolicy.mockResolvedValue(policy);

      const response = await POST(request);

      await expect(response.json()).resolves.toEqual({
        error: "Too many requests.",
        kind: "rate-limit",
      });
      expect(mocks.resolveSellerPolicy).toHaveBeenCalledWith("seller-1", { client: supabase });
      expect(mocks.enforceRateLimit).toHaveBeenCalledWith(request, "seller-1", { policy });
      expect(mocks.checkDailyItemQuota).not.toHaveBeenCalled();
    },
  );
});
