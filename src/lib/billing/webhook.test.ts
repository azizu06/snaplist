import { describe, expect, it } from "vitest";
import type { StripeSubscription, StripeWebhookEvent } from "./adapter";
import {
  handleStripeEvent,
  isHandledEvent,
  subscriptionFromStripe,
  subscriptionReferenceFromEvent,
  type EntitlementStore,
  type NormalizedSubscription,
} from "./webhook";

const PERIOD_END = 1_900_000_000; // unix seconds

const evt = (type: string, object: Record<string, unknown>, id = "evt_1"): StripeWebhookEvent => ({
  id,
  type,
  object,
});

const activeSubscription = (overrides: Partial<StripeSubscription> = {}): StripeSubscription => ({
  id: "sub_1",
  customerId: "cus_1",
  status: "active",
  currentPeriodEnd: PERIOD_END,
  ...overrides,
});

function fakeLifecycle(opts: {
  customerOwners?: Record<string, string>;
  subscription?: StripeSubscription;
  retrieveThrows?: Error;
  upsertThrows?: Error;
} = {}) {
  const processed = new Set<string>();
  const claims = new Map<string, string>();
  const upserts: NormalizedSubscription[] = [];
  const store: EntitlementStore = {
    async claimEvent(id) {
      if (processed.has(id)) return { state: "duplicate" as const };
      if (claims.has(id)) return { state: "in_progress" as const };
      const claimToken = `claim_${id}`;
      claims.set(id, claimToken);
      return { state: "claimed" as const, claimToken };
    },
    async completeEventClaim(id, claimToken) {
      if (claims.get(id) !== claimToken) throw new Error("claim lost");
      claims.delete(id);
      processed.add(id);
    },
    async releaseEventClaim(id, claimToken) {
      if (claims.get(id) === claimToken) claims.delete(id);
    },
    async userIdForStripeCustomer(customerId) {
      return opts.customerOwners?.[customerId] ?? null;
    },
    async upsertSubscription(sub) {
      if (opts.upsertThrows) throw opts.upsertThrows;
      upserts.push(sub);
    },
    async clearCheckoutReservation() {},
  };
  return {
    store,
    processed,
    upserts,
    adapter: {
      async retrieveSubscription(subscriptionId: string) {
        if (opts.retrieveThrows) throw opts.retrieveThrows;
        const subscription = opts.subscription ?? activeSubscription({ id: subscriptionId });
        if (subscription.id !== subscriptionId) throw new Error("unexpected Subscription id");
        return subscription;
      },
    },
  };
}

describe("subscriptionReferenceFromEvent (#152)", () => {
  it("takes only Stripe object ids, never metadata or a client reference, from handled events", () => {
    expect(
      subscriptionReferenceFromEvent(
        evt("checkout.session.completed", {
          customer: "cus_1",
          subscription: "sub_1",
          client_reference_id: "untrusted_user",
          metadata: { user_id: "untrusted_user" },
        }),
      ),
    ).toEqual({ customerId: "cus_1", subscriptionId: "sub_1" });

    expect(
      subscriptionReferenceFromEvent(
        evt("customer.subscription.updated", { customer: "cus_1", id: "sub_1" }),
      ),
    ).toEqual({ customerId: "cus_1", subscriptionId: "sub_1" });
    expect(
      subscriptionReferenceFromEvent(
        evt("invoice.payment_failed", { customer: "cus_1", subscription: "sub_1" }),
      ),
    ).toEqual({ customerId: "cus_1", subscriptionId: "sub_1" });
  });

  it("ignores an unhandled event or one without both Stripe ids", () => {
    expect(isHandledEvent("customer.created")).toBe(false);
    expect(subscriptionReferenceFromEvent(evt("customer.created", { id: "cus_1" }))).toBeNull();
    expect(subscriptionReferenceFromEvent(evt("checkout.session.completed", { customer: "cus_1" }))).toBeNull();
  });
});

describe("subscriptionFromStripe", () => {
  it("derives the entitlement from the authoritative Subscription status", () => {
    expect(subscriptionFromStripe("u1", activeSubscription()).tier).toBe("paid");
    expect(
      subscriptionFromStripe("u1", activeSubscription({ status: "past_due" })),
    ).toMatchObject({ status: "past_due", tier: "free" });
  });
});

describe("handleStripeEvent (#152 — idempotent lifecycle convergence)", () => {
  it("uses the current Subscription state after Checkout completed instead of granting paid from the session", async () => {
    const { store, upserts, adapter } = fakeLifecycle({
      customerOwners: { cus_1: "u1" },
      subscription: activeSubscription({ status: "incomplete" }),
    });

    await handleStripeEvent(
      evt("checkout.session.completed", { customer: "cus_1", subscription: "sub_1" }, "evt_checkout"),
      store,
      adapter,
    );

    expect(upserts).toEqual([
      expect.objectContaining({
        userId: "u1",
        stripeSubscriptionId: "sub_1",
        status: "incomplete",
        tier: "free",
      }),
    ]);
  });

  it("maps invoice.payment_failed by the durable Customer map without invoice metadata", async () => {
    const { store, upserts, adapter } = fakeLifecycle({
      customerOwners: { cus_1: "owner_from_server_map" },
      subscription: activeSubscription({ status: "past_due" }),
    });

    await handleStripeEvent(
      evt("invoice.payment_failed", { customer: "cus_1", subscription: "sub_1" }, "evt_invoice"),
      store,
      adapter,
    );

    expect(upserts[0]).toMatchObject({
      userId: "owner_from_server_map",
      status: "past_due",
      tier: "free",
    });
  });

  it("never uses attacker-controlled event metadata to choose a tenant", async () => {
    const { store, upserts, processed, adapter } = fakeLifecycle({
      subscription: activeSubscription(),
    });

    const result = await handleStripeEvent(
      evt(
        "customer.subscription.updated",
        { customer: "cus_unknown", id: "sub_1", metadata: { user_id: "attacker" } },
        "evt_unknown",
      ),
      store,
      adapter,
    );

    expect(result).toEqual({ processed: false, reason: "ignored" });
    expect(upserts).toHaveLength(0);
    expect(processed.has("evt_unknown")).toBe(true);
  });

  it("dedupes an exact replay without a second entitlement write", async () => {
    const { store, upserts, adapter } = fakeLifecycle({ customerOwners: { cus_1: "u1" } });
    const event = evt("customer.subscription.updated", { customer: "cus_1", id: "sub_1" });

    await handleStripeEvent(event, store, adapter);
    const replay = await handleStripeEvent(event, store, adapter);

    expect(replay).toEqual({ processed: false, reason: "duplicate" });
    expect(upserts).toHaveLength(1);
  });

  it("keeps a concurrent delivery retryable instead of applying it twice", async () => {
    const { store, upserts, adapter } = fakeLifecycle({ customerOwners: { cus_1: "u1" } });
    const event = evt("customer.subscription.updated", { customer: "cus_1", id: "sub_1" }, "evt_racing");
    await store.claimEvent(event.id, event.type); // another worker owns the atomic DB claim

    await expect(handleStripeEvent(event, store, adapter)).rejects.toThrow(/already being processed/i);
    expect(upserts).toHaveLength(0);
  });

  it("converges out-of-order delivery on Stripe's newest Subscription state", async () => {
    const { store, upserts, adapter } = fakeLifecycle({
      customerOwners: { cus_1: "u1" },
      // The older active event arrives after cancellation, but Stripe retrieval
      // still returns the current canceled state for both deliveries.
      subscription: activeSubscription({ status: "canceled" }),
    });

    await handleStripeEvent(
      evt("customer.subscription.deleted", { customer: "cus_1", id: "sub_1" }, "evt_newer"),
      store,
      adapter,
    );
    await handleStripeEvent(
      evt("customer.subscription.updated", { customer: "cus_1", id: "sub_1", status: "active" }, "evt_older"),
      store,
      adapter,
    );

    expect(upserts.map((sub) => ({ status: sub.status, tier: sub.tier }))).toEqual([
      { status: "canceled", tier: "free" },
      { status: "canceled", tier: "free" },
    ]);
  });

  it("timestamps the observation before a slow Stripe retrieval can become stale", async () => {
    let phase: "before" | "after" = "before";
    const { store, upserts } = fakeLifecycle({ customerOwners: { cus_1: "u1" } });
    const adapter = {
      async retrieveSubscription() {
        phase = "after";
        return activeSubscription();
      },
    };

    await handleStripeEvent(
      evt("customer.subscription.updated", { customer: "cus_1", id: "sub_1" }, "evt_slow"),
      store,
      adapter,
      () => new Date(phase === "before" ? "2030-01-01T00:00:00.000Z" : "2030-01-02T00:00:00.000Z"),
    );

    expect(upserts[0]?.stripeObservedAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("does not mark a failed retrieval or write as processed, so Stripe can retry", async () => {
    const retrieveFailure = fakeLifecycle({
      customerOwners: { cus_1: "u1" },
      retrieveThrows: new Error("Stripe unavailable"),
    });
    const event = evt("customer.subscription.updated", { customer: "cus_1", id: "sub_1" }, "evt_retry");
    await expect(handleStripeEvent(event, retrieveFailure.store, retrieveFailure.adapter)).rejects.toThrow(
      "Stripe unavailable",
    );
    expect(retrieveFailure.processed.has("evt_retry")).toBe(false);

    const writeFailure = fakeLifecycle({
      customerOwners: { cus_1: "u1" },
      upsertThrows: new Error("DB unavailable"),
    });
    await expect(handleStripeEvent(event, writeFailure.store, writeFailure.adapter)).rejects.toThrow(
      "DB unavailable",
    );
    expect(writeFailure.processed.has("evt_retry")).toBe(false);
  });
});
