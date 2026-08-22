import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyToken,
  createConfiguredSupabaseMobileRunOperations,
  createConfiguredSupabaseListingReviewReader,
  createConfiguredSupabaseListingReviewSaver,
  createInternalGuidedCorrectionCompletionRpcClient,
  createConfiguredVerifiedGuestPrincipalResolver,
  resolveGuest,
  mintOperationToken,
  readListingReview,
  saveListingReview,
  get,
  retry,
  cancel,
} = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  createConfiguredSupabaseMobileRunOperations: vi.fn(),
  createConfiguredSupabaseListingReviewReader: vi.fn(),
  createConfiguredSupabaseListingReviewSaver: vi.fn(),
  createInternalGuidedCorrectionCompletionRpcClient: vi.fn(),
  createConfiguredVerifiedGuestPrincipalResolver: vi.fn(),
  resolveGuest: vi.fn(),
  mintOperationToken: vi.fn(),
  readListingReview: vi.fn(),
  saveListingReview: vi.fn(),
  get: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));
vi.mock("@/lib/mobile-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mobile-api")>()),
  createConfiguredSupabaseMobileRunOperations,
}));
vi.mock("@/lib/listing-review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/listing-review")>()),
  createConfiguredSupabaseListingReviewReader,
  createConfiguredSupabaseListingReviewSaver,
}));
vi.mock("@/lib/pipeline/guided-correction-internal", () => ({
  createInternalGuidedCorrectionCompletionRpcClient,
}));
vi.mock("@/lib/guest-capability/configured", () => ({
  createConfiguredVerifiedGuestPrincipalResolver,
}));

import { GET } from "./route";
import { POST as retryPOST } from "./retry/route";
import { POST as cancelPOST } from "./cancel/route";
import { PUT as saveReviewPUT } from "./review/route";

const environmentKeys = [
  "CLERK_SECRET_KEY",
  "CLERK_AUTHORIZED_PARTIES",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_GUEST_JWT_KEY_ID",
  "SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM",
] as const;

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_release";
  process.env.CLERK_AUTHORIZED_PARTIES = "https://snaplist.example";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_release";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_release";
  process.env.SUPABASE_GUEST_JWT_KEY_ID = "guest-key-release";
  process.env.SUPABASE_GUEST_JWT_PRIVATE_KEY_PEM = "guest-private-key";
  verifyToken.mockResolvedValue({ sub: "user_release" });
  mintOperationToken
    .mockResolvedValueOnce("guest-run-jwt")
    .mockResolvedValueOnce("guest-review-jwt")
    .mockResolvedValueOnce("guest-photo-jwt");
  resolveGuest.mockResolvedValue({
    capabilityId: "24100000-0000-4000-8000-000000000009",
    kind: "verifiedGuest",
    mintOperationToken,
    userId: "guest_release",
  });
  createConfiguredVerifiedGuestPrincipalResolver.mockReturnValue({
    resolve: resolveGuest,
  });
  readListingReview.mockResolvedValue(null);
  createConfiguredSupabaseListingReviewReader.mockReturnValue({
    forRun: readListingReview,
  });
  createInternalGuidedCorrectionCompletionRpcClient.mockReturnValue({
    rpc: vi.fn(),
  });
  saveListingReview.mockResolvedValue({
    schemaVersion: 1,
    runId: "24100000-0000-4000-8000-000000000001",
    itemId: "24100000-0000-4000-8000-000000000002",
    listingId: "24100000-0000-4000-8000-000000000005",
    reviewRevision: "24100000-0000-4000-8000-000000000006",
  });
  createConfiguredSupabaseListingReviewSaver.mockReturnValue({
    save: saveListingReview,
  });
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

  it("resolves GuestBearer once and preserves per-operation mint authority", async () => {
    get.mockResolvedValueOnce({
      ...(await get()),
      listingId: "24100000-0000-4000-8000-000000000005",
      status: "succeeded",
      stage: "completed",
      terminalOutcome: "succeeded",
    });

    const response = await GET(
      new Request(
        "https://snaplist.example/v1/runs/24100000-0000-4000-8000-000000000001",
        { headers: { authorization: "Bearer guestcap_abcdefghijklmnopqrstuvwxyzABCDEFGH123456789" } },
      ),
    );

    expect(response.status).toBe(200);
    expect(verifyToken).not.toHaveBeenCalled();
    expect(createConfiguredVerifiedGuestPrincipalResolver).toHaveBeenCalledWith({
      keyId: "guest-key-release",
      privateKeyPem: "guest-private-key",
      secretKey: "sb_secret_release",
      supabaseURL: "https://project.supabase.co",
    });
    expect(resolveGuest).toHaveBeenCalledWith(
      "guestcap_abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
    );
    expect(mintOperationToken).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenLastCalledWith({
      runId: "24100000-0000-4000-8000-000000000001",
      userId: "guest_release",
      bearerToken: "guest-run-jwt",
    });
    expect(readListingReview).toHaveBeenCalledWith({
      runId: "24100000-0000-4000-8000-000000000001",
      userId: "guest_release",
      bearerToken: "guestcap_abcdefghijklmnopqrstuvwxyzABCDEFGH123456789",
      mintOperationToken,
    });
    expect(createConfiguredSupabaseListingReviewReader).toHaveBeenCalledWith({
      publishableKey: "sb_publishable_release",
      supabaseURL: "https://project.supabase.co",
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

  it("composes the production Listing Review save with RLS and narrow completion clients", async () => {
    const response = await saveReviewPUT(
      new Request(
        "https://snaplist.example/v1/runs/24100000-0000-4000-8000-000000000001/review",
        {
          method: "PUT",
          headers: {
            authorization: "Bearer signed-release-jwt",
            "content-type": "application/json",
            "idempotency-key": "24100000-0000-4000-8000-000000000006",
          },
          body: JSON.stringify({
            expectedReviewRevision:
              "24100000-0000-4000-8000-000000000004",
            title: "Sony headphones",
            description: "Tested and working.",
            condition: "good",
            specifics: [{ name: "Brand", value: "Sony" }],
            sellerPriceOverride: null,
          }),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(createConfiguredSupabaseListingReviewSaver).toHaveBeenCalledWith({
      supabaseURL: "https://project.supabase.co",
      publishableKey: "sb_publishable_release",
      completionClient: expect.objectContaining({ rpc: expect.any(Function) }),
      onProviderUsageError: expect.any(Function),
    });
    expect(saveListingReview).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "24100000-0000-4000-8000-000000000001",
        idempotencyKey: "24100000-0000-4000-8000-000000000006",
        userId: "user_release",
        bearerToken: "signed-release-jwt",
      }),
    );
  });
});
