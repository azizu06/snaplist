import { describe, expect, it } from "vitest";
import type { EbayPolicyLocationCandidates } from "./policy-location-contract";
import { MockEbayAdapter } from "./mock";
import {
  ensureEbayPolicyLocationBinding,
  type EbayPolicyLocationSetupStore,
} from "./policy-location-setup";

const CONNECTION_GENERATION = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_GENERATION = "33333333-3333-4333-8333-333333333333";

const CANDIDATES: EbayPolicyLocationCandidates = {
  fulfillmentPolicies: [
    { id: "mock-fulfillment", label: "Standard", providerDefault: false },
  ],
  paymentPolicies: [
    { id: "mock-payment", label: "Managed", providerDefault: false },
  ],
  returnPolicies: [
    { id: "mock-return", label: "30 days", providerDefault: false },
  ],
  inventoryLocations: [
    { id: "mock-location", label: "Home", providerDefault: false },
  ],
};

/** An in-memory stand-in for the RLS-backed store. */
function memoryStore(): EbayPolicyLocationSetupStore & { saved: unknown[] } {
  const saved: unknown[] = [];
  return {
    saved,
    async readStoredBinding() {
      return { connectionGeneration: CONNECTION_GENERATION, binding: undefined };
    },
    async readConnectionContext() {
      return {
        accountGeneration: ACCOUNT_GENERATION,
        connectionGeneration: CONNECTION_GENERATION,
      };
    },
    async saveBinding(binding) {
      saved.push(binding);
      return binding;
    },
  };
}

describe("MockEbayAdapter policy/location discovery (issue #47)", () => {
  it("has no discovery capability until a seller account is configured", async () => {
    const adapter = new MockEbayAdapter();

    // An offline mock cannot know any real seller's policy ids, so it must not
    // pretend to: the setup service then reports an honest unavailable state
    // instead of treating "nothing" as an empty eBay account.
    expect(adapter.discoverPolicyLocationCandidates).toBeUndefined();

    const setup = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter,
      store: memoryStore(),
    });
    expect(setup.state).toBe("unavailable");
  });

  it("answers discovery with the configured account and records the request", async () => {
    const adapter = new MockEbayAdapter({
      policyLocationCandidates: CANDIDATES,
    });
    const store = memoryStore();

    const setup = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter,
      store,
    });

    expect(setup.state).toBe("ready");
    expect(setup.binding?.fulfillmentPolicy).toMatchObject({
      state: "bound",
      selectedId: "mock-fulfillment",
    });
    expect(setup.binding?.inventoryLocation).toMatchObject({
      state: "bound",
      selectedId: "mock-location",
    });
    expect(store.saved).toHaveLength(1);
    expect(adapter.discoveryRequests).toEqual([
      { marketplaceId: "EBAY_US", accountGeneration: ACCOUNT_GENERATION },
    ]);
  });

  it("reports a configured provider failure instead of a usable binding", async () => {
    const adapter = new MockEbayAdapter({
      discoveryFailWith: new Error("eBay Account API is down"),
    });

    const setup = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter,
      store: memoryStore(),
    });

    expect(setup.state).toBe("unavailable");
    expect(setup.binding).toBeNull();
    expect((setup.cause as Error).message).toBe("eBay Account API is down");
  });

  it("models a seller who never created a return policy", async () => {
    const adapter = new MockEbayAdapter({
      policyLocationCandidates: { ...CANDIDATES, returnPolicies: [] },
    });

    const setup = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter,
      store: memoryStore(),
    });

    expect(setup.state).toBe("setupRequired");
    expect(setup.message).toMatch(/no return policy for EBAY_US/i);
  });
});
