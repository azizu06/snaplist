import { beforeEach, describe, expect, it, vi } from "vitest";
import { sellerPolicyForTier, type SellerPolicy } from "@/lib/billing/policy";

const mocks = vi.hoisted(() => ({
  redirect: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  revalidatePath: vi.fn(),
  createClient: vi.fn(),
  getUserId: vi.fn(),
  parseCostBasis: vi.fn(() => null),
  getAutopilotEnabled: vi.fn(),
  setAutopilotEnabled: vi.fn(),
  rateLimitAllows: vi.fn(),
  checkDailyItemQuota: vi.fn(),
  recordPipelineRunAndMaybeAlert: vi.fn(),
  refundDailyItem: vi.fn(),
  resolveSellerPolicy: vi.fn(),
}));

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ getUserId: mocks.getUserId }));
vi.mock("@/lib/pipeline", () => ({ runPipelineAndPersist: vi.fn() }));
vi.mock("@/lib/pipeline/autopilot", () => ({ parseCostBasis: mocks.parseCostBasis }));
vi.mock("@/lib/vision", () => ({ createVisionPipeline: vi.fn() }));
vi.mock("@/lib/settings/user-settings", () => ({
  getAutopilotEnabled: mocks.getAutopilotEnabled,
  setAutopilotEnabled: mocks.setAutopilotEnabled,
}));
vi.mock("@/lib/sentry", () => ({ reportServerError: vi.fn() }));
vi.mock("@/lib/abuse", () => ({
  checkDailyItemQuota: mocks.checkDailyItemQuota,
  rateLimitAllows: mocks.rateLimitAllows,
  recordPipelineRunAndMaybeAlert: mocks.recordPipelineRunAndMaybeAlert,
  refundDailyItem: mocks.refundDailyItem,
}));
vi.mock("@/lib/billing", () => ({ resolveSellerPolicy: mocks.resolveSellerPolicy }));

import { uploadAndProcess } from "./actions";

function validUpload(): FormData {
  const form = new FormData();
  form.append("photo", new File(["image"], "item.jpg", { type: "image/jpeg" }));
  return form;
}

describe("uploadAndProcess Seller policy enforcement (#153)", () => {
  const supabase = {};

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClient.mockResolvedValue(supabase);
    mocks.getUserId.mockResolvedValue("seller-1");
    mocks.rateLimitAllows.mockResolvedValue(true);
    mocks.checkDailyItemQuota.mockResolvedValue({ allowed: false, limit: 15 });
  });

  it.each([
    ["free", sellerPolicyForTier("free")],
    ["paid", sellerPolicyForTier("paid")],
    ["missing", sellerPolicyForTier("free")],
    ["canceled", sellerPolicyForTier("free")],
    ["cross-tenant", sellerPolicyForTier("free")],
  ] as const)(
    "uses the resolved %s policy for both the action rate guard and daily item cap",
    async (_state, policy: SellerPolicy) => {
      mocks.resolveSellerPolicy.mockResolvedValue(policy);

      await expect(uploadAndProcess(validUpload())).rejects.toThrow(/REDIRECT:/);

      expect(mocks.resolveSellerPolicy).toHaveBeenCalledWith("seller-1", { client: supabase });
      expect(mocks.rateLimitAllows).toHaveBeenCalledWith("seller-1", undefined, { policy });
      expect(mocks.checkDailyItemQuota).toHaveBeenCalledWith("seller-1", undefined, policy);
    },
  );
});
