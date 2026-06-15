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
  onInsert?: (row: unknown) => void;
  onUpsert?: (row: unknown, options: unknown) => void;
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
  } as unknown as SupabaseClient;
}

describe("getEntitlement (#64 — fail-safe tier read)", () => {
  it("returns paid for a paid mirror row", async () => {
    expect(await getEntitlement("u1", fakeClient({ selectData: { tier: "paid" } }))).toBe("paid");
  });

  it("returns free for a free row, a missing row, or an unknown value", async () => {
    expect(await getEntitlement("u1", fakeClient({ selectData: { tier: "free" } }))).toBe("free");
    expect(await getEntitlement("u1", fakeClient({ selectData: null }))).toBe("free");
    expect(await getEntitlement("u1", fakeClient({ selectData: { tier: "??" } }))).toBe("free");
  });

  it("NEVER throws / over-entitles on a read error — defaults free", async () => {
    expect(await getEntitlement("u1", fakeClient({ selectThrows: true }))).toBe("free");
  });
});

describe("createSupabaseEntitlementStore", () => {
  it("alreadyProcessed reflects whether the event row exists", async () => {
    const seen = createSupabaseEntitlementStore(fakeClient({ selectData: { event_id: "evt_1" } }));
    const unseen = createSupabaseEntitlementStore(fakeClient({ selectData: null }));
    expect(await seen.alreadyProcessed("evt_1")).toBe(true);
    expect(await unseen.alreadyProcessed("evt_1")).toBe(false);
  });

  it("markProcessed swallows a unique-violation (concurrent delivery) but rethrows others", async () => {
    const dup = createSupabaseEntitlementStore(fakeClient({ insertError: { code: "23505" } }));
    await expect(dup.markProcessed("evt_1", "t")).resolves.toBeUndefined();

    const fatal = createSupabaseEntitlementStore(fakeClient({ insertError: { code: "42501" } }));
    await expect(fatal.markProcessed("evt_1", "t")).rejects.toBeTruthy();
  });

  it("upsertSubscription maps the normalized state to the row and throws on error", async () => {
    let captured: Record<string, unknown> | undefined;
    const store = createSupabaseEntitlementStore(
      fakeClient({ onUpsert: (row) => (captured = row as Record<string, unknown>) }),
      () => new Date("2026-06-15T00:00:00.000Z"),
    );
    const sub: NormalizedSubscription = {
      userId: "u1",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      status: "active",
      currentPeriodEnd: "2026-07-01T00:00:00.000Z",
      tier: "paid",
    };
    await store.upsertSubscription(sub);
    expect(captured).toMatchObject({
      user_id: "u1",
      stripe_customer_id: "cus_1",
      stripe_subscription_id: "sub_1",
      tier: "paid",
      status: "active",
      current_period_end: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-06-15T00:00:00.000Z",
    });

    const failing = createSupabaseEntitlementStore(fakeClient({ upsertError: { message: "nope" } }));
    await expect(failing.upsertSubscription(sub)).rejects.toBeTruthy();
  });
});
