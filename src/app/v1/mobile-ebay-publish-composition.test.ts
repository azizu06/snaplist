import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verifyToken, logServerError } = vi.hoisted(() => ({
  verifyToken: vi.fn(),
  logServerError: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));
vi.mock("@/lib/api/errors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/errors")>()),
  logServerError,
}));

import { handleMobileEbayPublishRequest } from "./mobile-ebay-publish-composition";

/**
 * The eBay publish composition answers every internal failure with the same
 * generic 503. Without a wired `reportError` the optional-chained reporter in
 * `createMobileApiHandler` is a no-op, so that 503 is also the ONLY trace the
 * failure leaves: nothing in the server log, nothing in the response. That is
 * the swallowed-error shape that cost a night of production diagnosis on the
 * items-runs handler, and the publish path is the launch surface where it hurts
 * most.
 *
 * A bare `console.error` is only half a fix: on Vercel it is a log line nobody
 * is paged for. `logServerError` is the canonical seam every other route
 * reports through, and it forwards to Sentry (#62), so the report reaches the
 * place failures are actually watched.
 */
describe("mobile eBay publish composition", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_release";
    process.env.CLERK_AUTHORIZED_PARTIES = "https://snaplist.example";
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
    verifyToken.mockReset();
    logServerError.mockReset();
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_AUTHORIZED_PARTIES;
  });

  it("reports the underlying failure through the Sentry seam, not a bare console line", async () => {
    const failure = new Error("Clerk verification exploded");
    verifyToken.mockRejectedValue(failure);

    const response = await handleMobileEbayPublishRequest(
      new Request(
        "https://snaplist.example/v1/listings/11111111-1111-4111-8111-111111111111/ebay/publish",
        {
          method: "POST",
          headers: {
            authorization: "Bearer clerk-jwt",
            "content-type": "application/json",
            "idempotency-key": "77777777-7777-4777-8777-777777777777",
          },
          body: JSON.stringify({
            confirmation: "publish_to_ebay",
            expectedReviewRevision: "44444444-4444-4444-8444-444444444444",
          }),
        },
      ),
    );

    expect(response.status).toBe(401);
    expect(logServerError).toHaveBeenCalledWith(
      "mobile-api.authenticate",
      failure,
    );
  });
});
