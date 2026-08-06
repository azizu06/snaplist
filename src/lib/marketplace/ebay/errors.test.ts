import { describe, expect, it } from "vitest";
import { EBAY_RECONNECT_MESSAGE, isEbayAuthError, PublishValidationError } from "./errors";
import { EbayApiError } from "./types";

/**
 * Auth-failure classification for the publish error surfaces (UI/UX audit wave
 * 3). An expired/invalid eBay token is a condition the seller fixes by
 * reconnecting in Settings — the UI must say that instead of a generic "try
 * again" or a raw HTTP-401 message. The classifier is the pure seam both the
 * server action and the API route share.
 */

describe("isEbayAuthError", () => {
  it("classifies an HTTP 401 from the Sell API (invalid/expired access token)", () => {
    const err = new EbayApiError(
      "eBay POST /sell/inventory/v1/offer failed (HTTP 401): Invalid access token",
      401,
      { errors: [{ errorId: 1001, message: "Invalid access token" }] },
    );
    expect(isEbayAuthError(err)).toBe(true);
  });

  it("classifies a refresh-token grant rejection (invalid_grant), which eBay returns as HTTP 400", () => {
    const err = new EbayApiError(
      "eBay user-token refresh failed (HTTP 400); the seller may need to reconnect their eBay account in Settings",
      400,
      { error: "invalid_grant", error_description: "the provided authorization refresh token is invalid or was issued to another client" },
    );
    expect(isEbayAuthError(err)).toBe(true);
  });

  it("classifies an HTTP 403 insufficient_scope from the Sell Account API", () => {
    // Policy discovery (#47) needs `sell.account.readonly`. A connection minted
    // before that scope joined EBAY_OAUTH_SCOPES carries a token without it, and
    // eBay answers 403 rather than 401 — reconnecting is exactly the fix, and
    // exactly what the generic "unavailable" copy fails to tell the seller.
    expect(
      isEbayAuthError(
        new EbayApiError(
          "eBay GET /sell/account/v1/return_policy failed (HTTP 403)",
          403,
          {
            errors: [
              {
                errorId: 1100,
                domain: "ACCESS",
                category: "REQUEST",
                message: "Access denied",
                longMessage: "Insufficient permissions to fulfill the request.",
              },
            ],
          },
        ),
      ),
    ).toBe(true);
    // The OAuth bearer-token spelling of the same refusal.
    expect(
      isEbayAuthError(
        new EbayApiError("eBay GET /sell/account/v1/fulfillment_policy failed (HTTP 403)", 403, {
          error: "insufficient_scope",
          error_description: "the request requires higher privileges than provided by the access token",
        }),
      ),
    ).toBe(true);
  });

  it("does NOT classify a 403 that is not a scope or access refusal", () => {
    expect(
      isEbayAuthError(
        new EbayApiError("eBay GET /sell/account/v1/return_policy failed (HTTP 403)", 403, {
          errors: [
            {
              errorId: 20403,
              domain: "API_ACCOUNT",
              category: "BUSINESS",
              message: "The seller account is not eligible for business policies.",
            },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("does NOT classify a non-auth eBay failure (listing validation, server error)", () => {
    expect(
      isEbayAuthError(
        new EbayApiError("eBay POST /sell/inventory/v1/offer failed (HTTP 400): Invalid price", 400, {
          errors: [{ errorId: 25007, message: "Invalid price" }],
        }),
      ),
    ).toBe(false);
    expect(
      isEbayAuthError(new EbayApiError("eBay GET /x failed (HTTP 500)", 500, undefined)),
    ).toBe(false);
    // A non-JSON body (raw text) must not crash the classifier.
    expect(
      isEbayAuthError(new EbayApiError("eBay GET /x failed (HTTP 400)", 400, "Bad Request")),
    ).toBe(false);
  });

  it("does NOT classify non-EbayApiError failures (validation, internal, non-errors)", () => {
    expect(isEbayAuthError(new PublishValidationError("Listing has no price"))).toBe(false);
    expect(isEbayAuthError(new Error("supabase exploded"))).toBe(false);
    expect(isEbayAuthError(undefined)).toBe(false);
    expect(isEbayAuthError("string")).toBe(false);
  });
});

describe("EBAY_RECONNECT_MESSAGE", () => {
  it("is actionable: names the expiry and points at reconnecting in Settings", () => {
    expect(EBAY_RECONNECT_MESSAGE).toBe(
      "eBay connection expired — reconnect eBay in Settings and try again.",
    );
  });
});
