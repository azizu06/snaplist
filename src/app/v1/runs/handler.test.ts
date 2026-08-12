import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  verifyToken,
  createConfiguredSupabaseMobileRunOperations,
  createConfiguredSupabaseListingReviewReader,
  createConfiguredSupabaseListingReviewSaver,
  createInternalGuidedCorrectionCompletionRpcClient,
  createConfiguredVerifiedGuestPrincipalResolver,
  logServerError,
  get,
  list,
  retry,
  cancel,
} = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  createConfiguredSupabaseMobileRunOperations: vi.fn(),
  createConfiguredSupabaseListingReviewReader: vi.fn(),
  createConfiguredSupabaseListingReviewSaver: vi.fn(),
  createInternalGuidedCorrectionCompletionRpcClient: vi.fn(),
  createConfiguredVerifiedGuestPrincipalResolver: vi.fn(),
  logServerError: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  retry: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));
vi.mock("@/lib/api/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/errors")>()),
  logServerError,
}));
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

import { handleMobileRunRequest } from "./handler";

/**
 * `/v1/runs` and `/v1/runs/{id}` answer every internal failure with the same
 * generic 503. `createMobileApiHandler` reports through an OPTIONAL dependency,
 * so without a wired `reportError` that 503 is the only trace the failure
 * leaves: nothing in the server log, nothing in the response body. A production
 * 503 on this route was unrecoverable for exactly that reason (#796).
 *
 * `logServerError` is the canonical seam the rest of the API reports through —
 * it emits a structured `ok:false` line AND forwards to Sentry (#62) — so the
 * report lands where failures are watched instead of in a console line nobody
 * is paged for. It is the same shape `src/app/v1/items/runs/handler.ts` uses.
 *
 * The report must stay identifier-only. `docs/contracts/lean-mvp-retention-v1.json`
 * and ADR-0011 forbid seller voice transcript from reaching a server or worker
 * log — #795 tracks the worker-log tests that assert that redaction — so this
 * file also pins what the reported fields may contain.
 */

const environmentKeys = [
  "CLERK_SECRET_KEY",
  "CLERK_AUTHORIZED_PARTIES",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SECRET_KEY",
] as const;

const runId = "7c9ed6e9-db68-421a-9cb1-2dcd40b8d097";

beforeEach(() => {
  process.env.CLERK_SECRET_KEY = "sk_test_release";
  process.env.CLERK_AUTHORIZED_PARTIES = "https://snaplist.example";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "sb_publishable_release";
  process.env.SUPABASE_SECRET_KEY = "sb_secret_release";
  verifyToken.mockResolvedValue({ sub: "user_release" });
  createConfiguredSupabaseListingReviewReader.mockReturnValue({
    forRun: vi.fn().mockResolvedValue(null),
  });
  createConfiguredSupabaseListingReviewSaver.mockReturnValue({
    save: vi.fn(),
  });
  createInternalGuidedCorrectionCompletionRpcClient.mockReturnValue({
    rpc: vi.fn(),
  });
  createConfiguredSupabaseMobileRunOperations.mockReturnValue({
    get,
    list,
    retry,
    cancel,
  });
});

afterEach(() => {
  for (const key of environmentKeys) delete process.env[key];
  vi.clearAllMocks();
});

function runDetailRequest(): Request {
  return new Request(`https://snaplist.example/v1/runs/${runId}`, {
    headers: { authorization: "Bearer signed-release-jwt" },
  });
}

describe("production mobile durable-run composition error reporting", () => {
  it("reports the underlying run-detail failure through the Sentry seam", async () => {
    const failure = new Error("run projection read failed");
    get.mockRejectedValue(failure);

    const response = await handleMobileRunRequest(runDetailRequest());

    expect(response.status).toBe(503);
    expect(logServerError).toHaveBeenCalledWith(
      "mobile-api.run-detail",
      failure,
      expect.anything(),
    );
  });

  it("identifies the failing run in the report so a 503 is diagnosable", async () => {
    get.mockRejectedValue(new Error("run projection read failed"));

    await handleMobileRunRequest(runDetailRequest());

    expect(logServerError).toHaveBeenCalledWith(
      "mobile-api.run-detail",
      expect.any(Error),
      { runId },
    );
  });

  it("reports the run-history failure that answers /v1/runs with a 503", async () => {
    const failure = new Error("run history read failed");
    list.mockRejectedValue(failure);

    const response = await handleMobileRunRequest(
      new Request("https://snaplist.example/v1/runs", {
        headers: { authorization: "Bearer signed-release-jwt" },
      }),
    );

    expect(response.status).toBe(503);
    expect(logServerError).toHaveBeenCalledWith(
      "mobile-api.run-history",
      failure,
    );
  });

  it("keeps the 503 envelope and the report free of credentials and seller content", async () => {
    get.mockRejectedValue(
      new Error("run projection read failed for tenant user_release"),
    );

    const response = await handleMobileRunRequest(runDetailRequest());
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toEqual({
      error: {
        code: "internal_error",
        message: "Run status is temporarily unavailable.",
        requestId: expect.any(String),
      },
    });
    const [, , fields] = logServerError.mock.calls[0] ?? [];
    expect(fields).toEqual({ runId });
    expect(JSON.stringify(fields)).not.toContain("signed-release-jwt");
    expect(JSON.stringify(fields)).not.toContain("sb_secret_release");
  });
});
