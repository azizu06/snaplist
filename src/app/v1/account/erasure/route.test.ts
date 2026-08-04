import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  authenticateRequest,
  clerkClient,
  createConfiguredAccountErasureOperations,
  erase,
  has,
  reverificationErrorResponse,
} = vi.hoisted(() => ({
  authenticateRequest: vi.fn(),
  clerkClient: vi.fn(),
  createConfiguredAccountErasureOperations: vi.fn(),
  erase: vi.fn(),
  has: vi.fn(),
  reverificationErrorResponse: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ clerkClient, reverificationErrorResponse }));
vi.mock("@/lib/account-erasure/configured", () => ({
  createConfiguredAccountErasureOperations,
}));

import { POST } from "./route";

const environmentKeys = [
  "CLERK_SECRET_KEY",
  "CLERK_AUTHORIZED_PARTIES",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "REVENUECAT_SECRET_API_KEY",
  "REVENUECAT_PROJECT_ID",
  "POSTHOG_API_HOST",
  "POSTHOG_PROJECT_ID",
  "POSTHOG_PERSONAL_API_KEY",
] as const;
const idempotencyKey = "38430000-0000-4000-8000-000000000001";
const generationId = "38430000-0000-4000-8000-000000000002";

function request(): Request {
  return new Request("https://snaplist.example/v1/account/erasure", {
    method: "POST",
    headers: {
      authorization: "Bearer signed-release-jwt",
      "idempotency-key": idempotencyKey,
    },
  });
}

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_release";
  process.env.CLERK_AUTHORIZED_PARTIES = "https://snaplist.example";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_release";
  process.env.REVENUECAT_SECRET_API_KEY = "sk_revenuecat_release";
  process.env.REVENUECAT_PROJECT_ID = "proj_release";
  process.env.POSTHOG_API_HOST = "https://us.posthog.com";
  process.env.POSTHOG_PROJECT_ID = "617";
  process.env.POSTHOG_PERSONAL_API_KEY = "phx_test_release";
  has.mockReturnValue(true);
  authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => ({ userId: "user_release", has }),
  });
  clerkClient.mockResolvedValue({ authenticateRequest });
  erase.mockResolvedValue({
    generationId,
    status: "deletion_completed",
    retainedRecords: [],
    deferrals: [],
    attentionReasons: [],
    identity: null,
    storageObjects: [],
  });
  createConfiguredAccountErasureOperations.mockReturnValue({ erase });
  reverificationErrorResponse.mockReturnValue(new Response(JSON.stringify({
    clerk_error: { reason: "reverification-error" },
  }), { status: 403 }));
});

afterEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  vi.clearAllMocks();
});

describe("production account erasure route", () => {
  it("requires strict Clerk reverification before composing deletion authority", async () => {
    has.mockReturnValue(false);

    const response = await POST(request());

    expect(response.status).toBe(403);
    expect(has).toHaveBeenCalledWith({ reverification: "strict" });
    expect(reverificationErrorResponse).toHaveBeenCalledWith("strict");
    expect(createConfiguredAccountErasureOperations).not.toHaveBeenCalled();
    expect(erase).not.toHaveBeenCalled();
  });

  it("uses a reverified user with only the current secret-key adapter", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(authenticateRequest).toHaveBeenCalledWith(expect.any(Request), {
      acceptsToken: "session_token",
      authorizedParties: ["https://snaplist.example"],
    });
    expect(createConfiguredAccountErasureOperations).toHaveBeenCalledWith({
      clerkSecretKey: "sk_test_release",
      revenueCatProjectId: "proj_release",
      revenueCatSecretKey: "sk_revenuecat_release",
      postHogHost: "https://us.posthog.com",
      postHogProjectId: "617",
      postHogPersonalAPIKey: "phx_test_release",
      secretKey: "sb_secret_release",
      supabaseURL: "https://project.supabase.co",
    });
    expect(erase).toHaveBeenCalledWith({ userId: "user_release", idempotencyKey });
  });
});
