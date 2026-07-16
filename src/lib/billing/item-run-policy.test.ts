import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveNewAiItemRunPolicy } from "./item-run-policy";

const FUTURE_PERIOD_END = "2099-01-01T00:00:00.000Z";

type SubscriptionRow = {
  status: string;
  current_period_end?: unknown;
};

interface TenantFixture {
  tenantId: string;
  completedRunUserIds?: string[];
  subscriptions?: Record<string, SubscriptionRow>;
  listingReadError?: { message: string };
  queries?: Array<{ table: string; column: string; value: string }>;
}

/**
 * Minimal request-scoped Supabase fake. It models RLS by exposing rows only
 * when the requested user id matches the client's authenticated tenant.
 */
function tenantClient(fixture: TenantFixture): SupabaseClient {
  return {
    from(table: string) {
      return {
        select() {
          return {
            eq(column: string, value: string) {
              fixture.queries?.push({ table, column, value });

              if (table === "subscriptions") {
                return {
                  maybeSingle: async () => ({
                    data:
                      value === fixture.tenantId
                        ? (fixture.subscriptions?.[value] ?? null)
                        : null,
                    error: null,
                  }),
                };
              }

              if (table === "listings") {
                return {
                  not() {
                    return {
                      limit: async () => ({
                        data:
                          value === fixture.tenantId &&
                          fixture.completedRunUserIds?.includes(value)
                            ? [{ id: "generated-listing" }]
                            : [],
                        error: fixture.listingReadError ?? null,
                      }),
                    };
                  },
                };
              }

              throw new Error(`unexpected table: ${table}`);
            },
          };
        },
      };
    },
  } as unknown as SupabaseClient;
}

describe("resolveNewAiItemRunPolicy", () => {
  it.each([
    {
      name: "the included first run with no entitlement row",
      completedRun: false,
      subscription: undefined,
      allowed: true,
      reason: "included-first-run",
    },
    {
      name: "SnapList Pro after a completed run",
      completedRun: true,
      subscription: { status: "active", current_period_end: FUTURE_PERIOD_END },
      allowed: true,
      reason: "snaplist-pro",
    },
    {
      name: "a missing entitlement after a completed run",
      completedRun: true,
      subscription: undefined,
      allowed: false,
      reason: "snaplist-pro-required",
    },
    {
      name: "a canceled entitlement after a completed run",
      completedRun: true,
      subscription: { status: "canceled", current_period_end: FUTURE_PERIOD_END },
      allowed: false,
      reason: "snaplist-pro-required",
    },
    {
      name: "an expired active mirror after a completed run",
      completedRun: true,
      subscription: {
        status: "active",
        current_period_end: "2020-01-01T00:00:00.000Z",
      },
      allowed: false,
      reason: "snaplist-pro-required",
    },
    {
      name: "an active mirror without a period end after a completed run",
      completedRun: true,
      subscription: { status: "active" },
      allowed: false,
      reason: "snaplist-pro-required",
    },
    {
      name: "a malformed active mirror after a completed run",
      completedRun: true,
      subscription: { status: "active", current_period_end: "not-a-date" },
      allowed: false,
      reason: "snaplist-pro-required",
    },
  ])("resolves $name", async ({ completedRun, subscription, allowed, reason }) => {
    const client = tenantClient({
      tenantId: "tenant-a",
      completedRunUserIds: completedRun ? ["tenant-a"] : [],
      subscriptions: subscription ? { "tenant-a": subscription } : {},
    });

    await expect(
      resolveNewAiItemRunPolicy("tenant-a", { client }),
    ).resolves.toMatchObject({
      allowed,
      reason,
      hasCompletedAiItemRun: completedRun,
    });
  });

  it("does not let another tenant's paid mirror authorize this tenant", async () => {
    const queries: Array<{ table: string; column: string; value: string }> = [];
    const client = tenantClient({
      tenantId: "tenant-a",
      completedRunUserIds: ["tenant-a", "tenant-b"],
      subscriptions: {
        "tenant-b": { status: "active", current_period_end: FUTURE_PERIOD_END },
      },
      queries,
    });

    await expect(
      resolveNewAiItemRunPolicy("tenant-a", { client }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: "snaplist-pro-required",
    });
    expect(queries).toContainEqual({
      table: "listings",
      column: "user_id",
      value: "tenant-a",
    });
    expect(queries).toContainEqual({
      table: "subscriptions",
      column: "user_id",
      value: "tenant-a",
    });
  });

  it("fails closed when completed-run evidence cannot be read", async () => {
    const client = tenantClient({
      tenantId: "tenant-a",
      listingReadError: { message: "database unavailable" },
      subscriptions: {
        "tenant-a": { status: "active", current_period_end: FUTURE_PERIOD_END },
      },
    });

    await expect(
      resolveNewAiItemRunPolicy("tenant-a", { client }),
    ).resolves.toEqual({
      allowed: false,
      reason: "policy-unavailable",
      entitlement: "free",
      hasCompletedAiItemRun: null,
    });
  });
});
