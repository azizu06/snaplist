import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SELLER_CAPABILITY_MATRIX,
  resolveSellerPolicy,
  sellerPolicyForTier,
} from "./policy";

/**
 * Models the entitlement mirror's read-own RLS policy: requesting another
 * seller's row is indistinguishable from no entitlement row at this seam.
 */
function rlsEntitlementClient(
  viewerUserId: string,
  rows: ReadonlyMap<
    string,
    { status: string; tier?: string; current_period_end?: string | null }
  >,
): SupabaseClient {
  return {
    from() {
      return {
        select() {
          return {
            eq(_column: string, requestedUserId: string) {
              return {
                maybeSingle: async () => ({
                  data: requestedUserId === viewerUserId ? rows.get(requestedUserId) ?? null : null,
                  error: null,
                }),
              };
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe("Seller capability contract (#153)", () => {
  it.each([
    ["free", "photo-to-listing"],
    ["free", "bulk-haul-capture"],
    ["free", "ebay-publish-and-export"],
    ["free", "buyer-qa"],
    ["paid", "photo-to-listing"],
    ["paid", "bulk-haul-capture"],
    ["paid", "ebay-publish-and-export"],
    ["paid", "buyer-qa"],
  ] as const)("includes %s capability %s", (tier, capability) => {
    expect(sellerPolicyForTier(tier).capabilities[capability]).toBe(true);
  });

  it("keeps one explicit matrix: every advertised core capability is included in both plans", () => {
    expect(SELLER_CAPABILITY_MATRIX).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "bulk-haul-capture", free: true, paid: true }),
      ]),
    );
    expect(SELLER_CAPABILITY_MATRIX.every((row) => row.free && row.paid)).toBe(true);
  });
});

describe("resolveSellerPolicy (#153 server entitlement seam)", () => {
  it.each([
    ["active subscription", "seller-paid", { status: "active" }, "paid", 60, 200],
    ["trialing subscription", "seller-trial", { status: "trialing" }, "paid", 60, 200],
    [
      "expired active mirror",
      "seller-expired-active",
      { status: "active", current_period_end: "2020-01-01T00:00:00.000Z" },
      "free",
      20,
      15,
    ],
    [
      "expired trialing mirror",
      "seller-expired-trial",
      { status: "trialing", current_period_end: "2020-01-01T00:00:00.000Z" },
      "free",
      20,
      15,
    ],
    [
      "malformed active mirror period",
      "seller-malformed-period",
      { status: "active", current_period_end: "not-a-timestamp" },
      "free",
      20,
      15,
    ],
    ["missing entitlement", "seller-missing", undefined, "free", 20, 15],
    ["canceled stale mirror", "seller-canceled", { status: "canceled", tier: "paid" }, "free", 20, 15],
  ] as const)(
    "returns the truthful %s policy",
    async (_name, userId, row, expectedTier, meteredPerMinute, itemsPerDay) => {
      const rows = new Map<
        string,
        { status: string; tier?: string; current_period_end?: string | null }
      >();
      if (row) rows.set(userId, row);

      await expect(
        resolveSellerPolicy(userId, {
          client: rlsEntitlementClient(userId, rows),
          env: {},
        }),
      ).resolves.toMatchObject({
        tier: expectedTier,
        limits: { meteredPerMinute, itemsPerDay },
      });
    },
  );

  it("fails closed when a seller tries to resolve another tenant's paid mirror", async () => {
    const rows = new Map([["seller-paid", { status: "active" }]]);

    await expect(
      resolveSellerPolicy("seller-paid", {
        client: rlsEntitlementClient("seller-free", rows),
        env: {},
      }),
    ).resolves.toMatchObject({
      tier: "free",
      limits: { meteredPerMinute: 20, itemsPerDay: 15 },
    });
  });
});
