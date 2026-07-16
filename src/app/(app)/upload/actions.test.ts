import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const redirect = vi.fn((url: string): never => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  });
  return {
    redirect,
    revalidatePath: vi.fn(),
    createClient: vi.fn(),
    getUserId: vi.fn(),
    resolveNewAiItemRunPolicy: vi.fn(),
    checkDailyItemQuota: vi.fn(),
    rateLimitAllows: vi.fn(),
    recordPipelineRunAndMaybeAlert: vi.fn(),
    refundDailyItem: vi.fn(),
    parseCostBasis: vi.fn(),
    reportServerError: vi.fn(),
    runPipelineAndPersist: vi.fn(),
    createVisionPipeline: vi.fn(),
    getAutopilotEnabled: vi.fn(),
    setAutopilotEnabled: vi.fn(),
  };
});

const supabase = {
  storage: {
    from: vi.fn(() => ({
      upload: vi.fn(async () => ({ error: null })),
      remove: vi.fn(async () => ({ error: null })),
    })),
  },
};

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ getUserId: mocks.getUserId }));
vi.mock("@/lib/billing", () => ({
  resolveNewAiItemRunPolicy: mocks.resolveNewAiItemRunPolicy,
}));
vi.mock("@/lib/abuse", () => ({
  checkDailyItemQuota: mocks.checkDailyItemQuota,
  rateLimitAllows: mocks.rateLimitAllows,
  recordPipelineRunAndMaybeAlert: mocks.recordPipelineRunAndMaybeAlert,
  refundDailyItem: mocks.refundDailyItem,
}));
vi.mock("@/lib/pipeline", () => ({
  runPipelineAndPersist: mocks.runPipelineAndPersist,
}));
vi.mock("@/lib/pipeline/autopilot", () => ({
  parseCostBasis: mocks.parseCostBasis,
}));
vi.mock("@/lib/vision", () => ({
  createVisionPipeline: mocks.createVisionPipeline,
}));
vi.mock("@/lib/settings/user-settings", () => ({
  getAutopilotEnabled: mocks.getAutopilotEnabled,
  setAutopilotEnabled: mocks.setAutopilotEnabled,
}));
vi.mock("@/lib/sentry", () => ({ reportServerError: mocks.reportServerError }));

import { uploadAndProcess } from "./actions";

function validUpload(): FormData {
  const form = new FormData();
  form.set("photo", new File(["image"], "item.jpg", { type: "image/jpeg" }));
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockResolvedValue(supabase);
  mocks.getUserId.mockResolvedValue("tenant-a");
  mocks.parseCostBasis.mockReturnValue(null);
  mocks.rateLimitAllows.mockResolvedValue(true);
  mocks.checkDailyItemQuota.mockResolvedValue({ allowed: false, used: 8, limit: 7 });
});

describe("uploadAndProcess new AI-item authorization", () => {
  it("blocks a free second run before daily capacity, storage, or provider work", async () => {
    mocks.resolveNewAiItemRunPolicy.mockResolvedValue({
      allowed: false,
      reason: "snaplist-pro-required",
      entitlement: "free",
      hasCompletedAiItemRun: true,
    });

    await expect(uploadAndProcess(validUpload())).rejects.toThrow("NEXT_REDIRECT:");

    expect(mocks.resolveNewAiItemRunPolicy).toHaveBeenCalledWith("tenant-a", {
      client: supabase,
    });
    expect(decodeURIComponent(mocks.redirect.mock.calls[0][0])).toMatch(/SnapList Pro/i);
    expect(mocks.rateLimitAllows).toHaveBeenCalledWith("tenant-a");
    expect(mocks.checkDailyItemQuota).not.toHaveBeenCalled();
    expect(supabase.storage.from).not.toHaveBeenCalled();
    expect(mocks.createVisionPipeline).not.toHaveBeenCalled();
  });

  it("keeps the daily control separate and neutral after policy authorization", async () => {
    mocks.resolveNewAiItemRunPolicy.mockResolvedValue({
      allowed: true,
      reason: "included-first-run",
      entitlement: "free",
      hasCompletedAiItemRun: false,
    });

    await expect(uploadAndProcess(validUpload())).rejects.toThrow("NEXT_REDIRECT:");

    expect(mocks.resolveNewAiItemRunPolicy).toHaveBeenCalledOnce();
    expect(mocks.rateLimitAllows).toHaveBeenCalledWith("tenant-a");
    expect(mocks.checkDailyItemQuota).toHaveBeenCalledWith("tenant-a");
    const destination = decodeURIComponent(mocks.redirect.mock.calls[0][0]);
    expect(destination).toMatch(/capacity/i);
    expect(destination).not.toMatch(/free plan|pro plan|items\/day|\(7/i);
  });
});
