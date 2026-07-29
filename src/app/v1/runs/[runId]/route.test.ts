import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verifyToken, createConfiguredSupabaseMobileRunOperations, get, retry, cancel } = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  createConfiguredSupabaseMobileRunOperations: vi.fn(),
  get: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));
vi.mock("@/lib/mobile-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mobile-api")>()),
  createConfiguredSupabaseMobileRunOperations,
}));

import { GET } from "./route";
import { POST as retryPOST } from "./retry/route";
import { POST as cancelPOST } from "./cancel/route";

const environmentKeys = [
  "CLERK_SECRET_KEY",
  "CLERK_AUTHORIZED_PARTIES",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
] as const;

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_release";
  process.env.CLERK_AUTHORIZED_PARTIES = "https://snaplist.example";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_release";
  verifyToken.mockResolvedValue({ sub: "user_release" });
  get.mockResolvedValue({
    id: "24100000-0000-4000-8000-000000000001",
    itemId: "24100000-0000-4000-8000-000000000002",
    listingId: null,
    status: "queued",
    stage: "queued",
    attemptCount: 0,
    maxAttempts: 3,
    schemaVersion: 1,
    timestamps: {
      createdAt: "2026-07-19T18:00:00.000Z",
      updatedAt: "2026-07-19T18:00:00.000Z",
      enqueuedAt: "2026-07-19T18:00:00.000Z",
      startedAt: null,
      lastAttemptedAt: null,
      nextAttemptAt: null,
      completedAt: null,
      retentionCleanedAt: null,
    },
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
    lastMeaningfulUpdateAt: "2026-07-19T18:00:00.000Z",
    retentionCleanedAt: null,
  });
  retry.mockImplementation(get.getMockImplementation() ?? (() => undefined));
  cancel.mockImplementation(get.getMockImplementation() ?? (() => undefined));
  createConfiguredSupabaseMobileRunOperations.mockReturnValue({
    get,
    retry,
    cancel,
  });
});

afterEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  vi.clearAllMocks();
});

describe("production mobile durable-run route composition", () => {
  it("verifies Clerk and binds the same bearer to the RLS run adapter", async () => {
    const response = await GET(
      new Request(
        "https://snaplist.example/v1/runs/24100000-0000-4000-8000-000000000001",
        { headers: { authorization: "Bearer signed-release-jwt" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(verifyToken).toHaveBeenCalledWith("signed-release-jwt", {
      secretKey: "sk_test_release",
      authorizedParties: ["https://snaplist.example"],
    });
    expect(createConfiguredSupabaseMobileRunOperations).toHaveBeenCalledWith({
      supabaseURL: "https://project.supabase.co",
      anonKey: "sb_publishable_release",
      cursorSigningSecret: "sk_test_release",
    });
    expect(get).toHaveBeenCalledWith({
      runId: "24100000-0000-4000-8000-000000000001",
      userId: "user_release",
      bearerToken: "signed-release-jwt",
    });
  });

  it("dispatches the production retry route through the same authenticated adapter", async () => {
    retry.mockResolvedValueOnce(await get());
    const response = await retryPOST(
      new Request(
        "https://snaplist.example/v1/runs/24100000-0000-4000-8000-000000000001/retry",
        {
          method: "POST",
          headers: {
            authorization: "Bearer signed-release-jwt",
            "idempotency-key": "24100000-0000-4000-8000-000000000003",
          },
        },
      ),
    );

    expect(response.status).toBe(202);
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({
      runId: "24100000-0000-4000-8000-000000000001",
      userId: "user_release",
      bearerToken: "signed-release-jwt",
      idempotencyKey: "24100000-0000-4000-8000-000000000003",
    }));
  });

  it("dispatches the production cancel route through the same authenticated adapter", async () => {
    cancel.mockResolvedValueOnce(await get());
    const response = await cancelPOST(
      new Request(
        "https://snaplist.example/v1/runs/24100000-0000-4000-8000-000000000001/cancel",
        {
          method: "POST",
          headers: {
            authorization: "Bearer signed-release-jwt",
            "idempotency-key": "24100000-0000-4000-8000-000000000004",
          },
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({
      runId: "24100000-0000-4000-8000-000000000001",
      userId: "user_release",
      bearerToken: "signed-release-jwt",
      idempotencyKey: "24100000-0000-4000-8000-000000000004",
    }));
  });
});
