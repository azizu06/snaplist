import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { verifyToken } = vi.hoisted(() => ({ verifyToken: vi.fn() }));

vi.mock("@clerk/nextjs/server", () => ({ verifyToken }));

import { handleMobileEbayPublishRequest } from "./mobile-ebay-publish-composition";

/**
 * The eBay publish composition answers every internal failure with the same
 * generic 503. Without a wired `reportError` the optional-chained reporter in
 * `createMobileApiHandler` is a no-op, so that 503 is also the ONLY trace the
 * failure leaves: nothing in the server log, nothing in the response. That is
 * the swallowed-error shape that cost a night of production diagnosis on the
 * items-runs handler, and the publish path is the launch surface where it hurts
 * most.
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
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_AUTHORIZED_PARTIES;
  });

  it("reports the underlying failure server-side instead of only answering the client", async () => {
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
    expect(consoleError).toHaveBeenCalledWith(
      "[mobile-api.authenticate]",
      failure,
    );
  });
});
