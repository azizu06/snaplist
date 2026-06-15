import { describe, expect, it } from "vitest";
import {
  handleStripeEvent,
  isHandledEvent,
  subscriptionFromEvent,
  type EntitlementStore,
  type NormalizedSubscription,
} from "./webhook";
import type { StripeWebhookEvent } from "./adapter";

const PERIOD_END = 1_900_000_000; // unix seconds

const evt = (type: string, object: Record<string, unknown>, id = "evt_1"): StripeWebhookEvent => ({
  id,
  type,
  object,
});

function fakeStore(overrides: Partial<EntitlementStore> = {}) {
  const processed = new Set<string>();
  const upserts: NormalizedSubscription[] = [];
  const store: EntitlementStore = {
    async alreadyProcessed(id) {
      return processed.has(id);
    },
    async markProcessed(id) {
      processed.add(id);
    },
    async upsertSubscription(sub) {
      upserts.push(sub);
    },
    ...overrides,
  };
  return { store, processed, upserts };
}

describe("subscriptionFromEvent (#64 — pure event → entitlement)", () => {
  it("checkout.session.completed → active/paid, mapped to the user", () => {
    const sub = subscriptionFromEvent(
      evt("checkout.session.completed", {
        customer: "cus_1",
        subscription: "sub_1",
        client_reference_id: "u1",
      }),
    );
    expect(sub).toMatchObject({
      userId: "u1",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      status: "active",
      tier: "paid",
    });
  });

  it("customer.subscription.updated active → paid with an ISO period end", () => {
    const sub = subscriptionFromEvent(
      evt("customer.subscription.updated", {
        id: "sub_1",
        customer: "cus_1",
        status: "active",
        current_period_end: PERIOD_END,
        metadata: { user_id: "u1" },
      }),
    );
    expect(sub?.tier).toBe("paid");
    expect(sub?.status).toBe("active");
    expect(sub?.currentPeriodEnd).toBe(new Date(PERIOD_END * 1000).toISOString());
  });

  it("a not-in-good-standing subscription status maps to free", () => {
    const sub = subscriptionFromEvent(
      evt("customer.subscription.updated", {
        id: "sub_1",
        customer: "cus_1",
        status: "past_due",
        metadata: { user_id: "u1" },
      }),
    );
    expect(sub?.tier).toBe("free");
  });

  it("customer.subscription.deleted → canceled/free", () => {
    const sub = subscriptionFromEvent(
      evt("customer.subscription.deleted", { id: "sub_1", customer: "cus_1", metadata: { user_id: "u1" } }),
    );
    expect(sub).toMatchObject({ status: "canceled", tier: "free", stripeSubscriptionId: "sub_1" });
  });

  it("invoice.payment_failed → past_due/free (downgrade on non-payment)", () => {
    const sub = subscriptionFromEvent(
      evt("invoice.payment_failed", { customer: "cus_1", subscription: "sub_1", metadata: { user_id: "u1" } }),
    );
    expect(sub).toMatchObject({ status: "past_due", tier: "free" });
  });

  it("ignores unhandled event types", () => {
    expect(isHandledEvent("customer.created")).toBe(false);
    expect(subscriptionFromEvent(evt("customer.created", { id: "cus_1" }))).toBeNull();
  });

  it("ignores a handled event with no resolvable user id", () => {
    expect(
      subscriptionFromEvent(evt("customer.subscription.updated", { id: "sub_1", status: "active" })),
    ).toBeNull();
  });
});

describe("handleStripeEvent (#64 — idempotency)", () => {
  const activeEvent = evt("customer.subscription.updated", {
    id: "sub_1",
    customer: "cus_1",
    status: "active",
    metadata: { user_id: "u1" },
  });

  it("processes a fresh event: upserts once and marks processed", async () => {
    const { store, processed, upserts } = fakeStore();
    const r = await handleStripeEvent(activeEvent, store);
    expect(r).toEqual({ processed: true });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].tier).toBe("paid");
    expect(processed.has("evt_1")).toBe(true);
  });

  it("dedupes a replayed event — no second upsert", async () => {
    const { store, upserts } = fakeStore();
    await handleStripeEvent(activeEvent, store);
    const r2 = await handleStripeEvent(activeEvent, store); // same id, redelivered
    expect(r2).toEqual({ processed: false, reason: "duplicate" });
    expect(upserts).toHaveLength(1); // exactly one entitlement write
  });

  it("marks an ignored event processed without upserting (won't re-evaluate on retry)", async () => {
    const { store, processed, upserts } = fakeStore();
    const r = await handleStripeEvent(evt("customer.created", { id: "cus_1" }), store);
    expect(r).toEqual({ processed: false, reason: "ignored" });
    expect(upserts).toHaveLength(0);
    expect(processed.has("evt_1")).toBe(true);
  });

  it("does NOT mark processed when the upsert fails — so Stripe's retry re-processes", async () => {
    const { store, processed } = fakeStore({
      async upsertSubscription() {
        throw new Error("db down");
      },
    });
    await expect(handleStripeEvent(activeEvent, store)).rejects.toThrow("db down");
    expect(processed.has("evt_1")).toBe(false); // not acked → redelivery will retry
  });
});
