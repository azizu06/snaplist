import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseEntitlementStore, getEntitlement } from "./entitlement";
import type { NormalizedSubscription } from "./webhook";

/** A minimal chainable fake of the supabase-js surface these functions use. */
function fakeClient(opts: {
  selectData?: unknown;
  selectThrows?: boolean;
  insertError?: { code?: string } | null;
  upsertError?: unknown;
  rpcError?: unknown;
  rpcData?: unknown;
  onInsert?: (row: unknown) => void;
  onUpsert?: (row: unknown, options: unknown) => void;
  onRpc?: (name: string, args: unknown) => void;
}): SupabaseClient {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => {
                  if (opts.selectThrows) throw new Error("db unreachable");
                  return { data: opts.selectData ?? null, error: null };
                },
              };
            },
          };
        },
        insert: async (row: unknown) => {
          opts.onInsert?.(row);
          return { error: opts.insertError ?? null };
        },
        upsert: async (row: unknown, options: unknown) => {
          opts.onUpsert?.(row, options);
          return { error: opts.upsertError ?? null };
        },
      };
    },
    rpc: async (name: string, args: unknown) => {
      opts.onRpc?.(name, args);
      return { data: opts.rpcData ?? true, error: opts.rpcError ?? null };
    },
  } as unknown as SupabaseClient;
}

describe("getEntitlement (#64 — fail-safe tier read)", () => {
  it("returns paid for a paid mirror row", async () => {
    expect(await getEntitlement("u1", fakeClient({ selectData: { status: "active" } }))).toBe("paid");
  });

  it("returns free for a free row, a missing row, or an unknown value", async () => {
    expect(await getEntitlement("u1", fakeClient({ selectData: { status: "canceled" } }))).toBe("free");
    expect(await getEntitlement("u1", fakeClient({ selectData: null }))).toBe("free");
    expect(await getEntitlement("u1", fakeClient({ selectData: { status: "??" } }))).toBe("free");
  });

  it("derives from status rather than trusting a redundant tier column", async () => {
    expect(
      await getEntitlement("u1", fakeClient({ selectData: { status: "canceled", tier: "paid" } })),
    ).toBe("free");
  });

  it.each([
    ["active", "2020-01-01T00:00:00.000Z"],
    ["trialing", "2020-01-01T00:00:00.000Z"],
    ["active", "not-a-timestamp"],
  ])("fails closed for a %s mirror with an expired or malformed period", async (status, currentPeriodEnd) => {
    expect(
      await getEntitlement(
        "u1",
        fakeClient({ selectData: { status, current_period_end: currentPeriodEnd } }),
      ),
    ).toBe("free");
  });

  it("NEVER throws / over-entitles on a read error — defaults free", async () => {
    expect(await getEntitlement("u1", fakeClient({ selectThrows: true }))).toBe("free");
  });
});

describe("createSupabaseEntitlementStore", () => {
  it("claims an event atomically through the service-role RPC", async () => {
    let captured: { name: string; args: unknown } | undefined;
    const store = createSupabaseEntitlementStore(fakeClient({
      rpcData: [{ state: "claimed", claim_token: "claim_1" }],
      onRpc: (name, args) => (captured = { name, args }),
    }));
    await expect(store.claimEvent("evt_1", "customer.subscription.updated")).resolves.toEqual({
      state: "claimed",
      claimToken: "claim_1",
    });
    expect(captured).toEqual({
      name: "claim_stripe_event",
      args: { p_event_id: "evt_1", p_type: "customer.subscription.updated" },
    });
  });

  it("upsertSubscription invokes the monotonic service-role RPC and throws on error", async () => {
    let captured: Record<string, unknown> | undefined;
    const store = createSupabaseEntitlementStore(
      fakeClient({ onRpc: (name, args) => {
        if (name === "upsert_billing_subscription") captured = args as Record<string, unknown>;
      } }),
    );
    const sub: NormalizedSubscription = {
      userId: "u1",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      status: "active",
      currentPeriodEnd: "2026-07-01T00:00:00.000Z",
      stripeObservedAt: "2026-06-15T00:00:00.000Z",
      tier: "paid",
    };
    await store.upsertSubscription(sub);
    expect(captured).toMatchObject({
      p_user_id: "u1",
      p_stripe_customer_id: "cus_1",
      p_stripe_subscription_id: "sub_1",
      p_status: "active",
      p_current_period_end: "2026-07-01T00:00:00.000Z",
      p_stripe_observed_at: "2026-06-15T00:00:00.000Z",
    });

    const failing = createSupabaseEntitlementStore(fakeClient({ rpcError: { message: "nope" } }));
    await expect(failing.upsertSubscription(sub)).rejects.toBeTruthy();
  });
});

describe("billing Customer mapping (#152)", () => {
  it("persists a Customer once and resolves the owning Clerk user only by that server map", async () => {
    const customers = new Map<string, { user_id: string; stripe_customer_id: string }>();
    const admin = {
      from(table: string) {
        if (table !== "billing_customers") throw new Error(`unexpected table: ${table}`);
        return {
          select() {
            return {
              eq(column: "user_id" | "stripe_customer_id", value: string) {
                return {
                  maybeSingle: async () => {
                    const row =
                      column === "user_id"
                        ? customers.get(value)
                        : [...customers.values()].find((customer) => customer.stripe_customer_id === value) ?? null;
                    return { data: row ?? null, error: null };
                  },
                };
              },
            };
          },
          insert: async (row: { user_id: string; stripe_customer_id: string }) => {
            customers.set(row.user_id, row);
            return { error: null };
          },
        };
      },
    } as unknown as SupabaseClient;
    const store = createSupabaseEntitlementStore(admin);

    expect(await store.customerIdForUser("user_1")).toBeNull();
    await store.saveCustomerIdForUser("user_1", "cus_1");
    expect(await store.customerIdForUser("user_1")).toBe("cus_1");
    expect(await store.userIdForStripeCustomer("cus_1")).toBe("user_1");
  });
});
