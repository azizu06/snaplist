import { describe, expect, it } from "vitest";
import { ensureEbayPolicyLocationBinding } from "./policy-location-setup";
import type {
  EbayPolicyLocationBinding,
  EbayPolicyLocationCandidates,
} from "./policy-location-contract";
import type { EbayPolicyLocationSetupStore } from "./policy-location-setup";
import { EbayApiError } from "./types";

const CONNECTION_GENERATION = "11111111-1111-4111-8111-111111111111";
const NEXT_CONNECTION_GENERATION = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_GENERATION = "33333333-3333-4333-8333-333333333333";

function candidate(id: string) {
  return { id, label: id, providerDefault: false };
}

function candidatesFor(seller: string): EbayPolicyLocationCandidates {
  return {
    fulfillmentPolicies: [candidate(`${seller}-fulfillment`)],
    paymentPolicies: [candidate(`${seller}-payment`)],
    returnPolicies: [candidate(`${seller}-return`)],
    inventoryLocations: [candidate(`${seller}-location`)],
  };
}

function readyBinding(
  marketplaceId: string,
  connectionGeneration: string,
  seller: string,
): EbayPolicyLocationBinding {
  const choice = (kind: string) => ({
    state: "bound" as const,
    selectedId: `${seller}-${kind}`,
    candidates: [candidate(`${seller}-${kind}`)],
  });
  return {
    state: "ready",
    marketplaceId,
    connectionGeneration,
    fulfillmentPolicy: choice("fulfillment"),
    paymentPolicy: choice("payment"),
    returnPolicy: choice("return"),
    inventoryLocation: choice("location"),
    discoveredAt: "2026-08-06T00:00:00.000Z",
  };
}

interface FakeStoreOptions {
  connectionGeneration?: string | null;
  stored?: unknown;
}

function fakeStore(options: FakeStoreOptions = {}): EbayPolicyLocationSetupStore & {
  saved: EbayPolicyLocationBinding[];
} {
  const connectionGeneration =
    options.connectionGeneration === undefined
      ? CONNECTION_GENERATION
      : options.connectionGeneration;
  const saved: EbayPolicyLocationBinding[] = [];
  let stored = options.stored;
  return {
    saved,
    async readStoredBinding() {
      if (connectionGeneration === null) return null;
      return { connectionGeneration, binding: stored };
    },
    async readConnectionContext() {
      if (connectionGeneration === null) return null;
      return {
        accountGeneration: ACCOUNT_GENERATION,
        connectionGeneration,
      };
    },
    async saveBinding(binding) {
      saved.push(binding);
      stored = binding;
      return binding;
    },
  };
}

function discoveringAdapter(candidates: EbayPolicyLocationCandidates) {
  const calls: Array<{ marketplaceId: string; accountGeneration: string }> = [];
  return {
    calls,
    async discoverPolicyLocationCandidates(input: {
      marketplaceId: string;
      accountGeneration: string;
    }) {
      calls.push(input);
      return candidates;
    },
  };
}

describe("ensureEbayPolicyLocationBinding", () => {
  it("discovers and persists the connected seller's own policy ids", async () => {
    const store = fakeStore();
    const adapter = discoveringAdapter(candidatesFor("seller-a"));

    const setup = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter,
      store,
      now: () => Date.parse("2026-08-06T00:00:00.000Z"),
    });

    expect(setup.state).toBe("ready");
    expect(adapter.calls).toEqual([
      { marketplaceId: "EBAY_US", accountGeneration: ACCOUNT_GENERATION },
    ]);
    expect(setup.binding?.fulfillmentPolicy.selectedId).toBe(
      "seller-a-fulfillment",
    );
    expect(setup.binding?.paymentPolicy.selectedId).toBe("seller-a-payment");
    expect(setup.binding?.returnPolicy.selectedId).toBe("seller-a-return");
    expect(setup.binding?.inventoryLocation.selectedId).toBe(
      "seller-a-location",
    );
    expect(setup.message).toBeNull();
    expect(store.saved).toHaveLength(1);
  });

  it("keeps two connected sellers on their own discovered ids", async () => {
    const first = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter: discoveringAdapter(candidatesFor("seller-a")),
      store: fakeStore(),
    });
    const second = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter: discoveringAdapter(candidatesFor("seller-b")),
      store: fakeStore({
        connectionGeneration: NEXT_CONNECTION_GENERATION,
      }),
    });

    expect(first.binding?.fulfillmentPolicy.selectedId).toBe(
      "seller-a-fulfillment",
    );
    expect(second.binding?.fulfillmentPolicy.selectedId).toBe(
      "seller-b-fulfillment",
    );
  });

  it("reuses a stored binding for the current connection without calling eBay", async () => {
    const store = fakeStore({
      stored: readyBinding("EBAY_US", CONNECTION_GENERATION, "seller-a"),
    });
    const adapter = discoveringAdapter(candidatesFor("seller-b"));

    const setup = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter,
      store,
    });

    expect(adapter.calls).toEqual([]);
    expect(setup.state).toBe("ready");
    expect(setup.binding?.fulfillmentPolicy.selectedId).toBe(
      "seller-a-fulfillment",
    );
  });

  it("re-discovers after the seller reconnects under a new generation", async () => {
    const store = fakeStore({
      connectionGeneration: NEXT_CONNECTION_GENERATION,
      stored: readyBinding("EBAY_US", CONNECTION_GENERATION, "seller-a"),
    });
    const adapter = discoveringAdapter(candidatesFor("seller-b"));

    const setup = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter,
      store,
    });

    expect(adapter.calls).toHaveLength(1);
    expect(setup.binding?.connectionGeneration).toBe(
      NEXT_CONNECTION_GENERATION,
    );
    expect(setup.binding?.fulfillmentPolicy.selectedId).toBe(
      "seller-b-fulfillment",
    );
  });

  it("re-discovers for a marketplace the stored binding does not cover", async () => {
    const store = fakeStore({
      stored: readyBinding("EBAY_GB", CONNECTION_GENERATION, "seller-a"),
    });
    const adapter = discoveringAdapter(candidatesFor("seller-a-us"));

    const setup = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter,
      store,
    });

    expect(adapter.calls).toEqual([
      { marketplaceId: "EBAY_US", accountGeneration: ACCOUNT_GENERATION },
    ]);
    expect(setup.binding?.marketplaceId).toBe("EBAY_US");
  });

  it("reports the exact missing setup when the seller has no usable policies", async () => {
    const setup = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter: discoveringAdapter({
        fulfillmentPolicies: [candidate("seller-a-fulfillment")],
        paymentPolicies: [candidate("seller-a-payment")],
        returnPolicies: [],
        inventoryLocations: [],
      }),
      store: fakeStore(),
    });

    expect(setup.state).toBe("setupRequired");
    expect(setup.binding).toBeNull();
    expect(setup.message).toBe(
      "Your eBay account has no return policy or inventory location for EBAY_US. "
        + "Add them in eBay, then try publishing again.",
    );
  });

  it("reports an ambiguous choice instead of guessing a policy", async () => {
    const setup = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter: discoveringAdapter({
        fulfillmentPolicies: [
          candidate("seller-a-fulfillment-1"),
          candidate("seller-a-fulfillment-2"),
        ],
        paymentPolicies: [candidate("seller-a-payment")],
        returnPolicies: [candidate("seller-a-return")],
        inventoryLocations: [candidate("seller-a-location")],
      }),
      store: fakeStore(),
    });

    expect(setup.state).toBe("selectionRequired");
    expect(setup.binding).toBeNull();
    expect(setup.message).toBe(
      "Your eBay account has more than one shipping policy for EBAY_US, and "
        + "SnapList cannot choose for you. Keep one usable option in eBay, then "
        + "try publishing again.",
    );
  });

  it("reports an unavailable read instead of substituting another seller's ids", async () => {
    // eBay itself answering non-2xx is the ONE failure on this path that is
    // genuinely about the seller's eBay side, and the HTTP discovery adapter
    // reports exactly that shape (`EbayApiError`) — never a bare `Error`.
    const failure = new EbayApiError(
      "eBay GET /sell/account/v1/payment_policy failed (HTTP 500)",
      500,
      undefined,
    );
    const setup = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter: {
        async discoverPolicyLocationCandidates() {
          throw failure;
        },
      },
      store: fakeStore(),
    });

    expect(setup.state).toBe("unavailable");
    expect(setup.binding).toBeNull();
    expect(setup.message).toBe(
      "SnapList could not read your eBay shipping, payment, and return policies. "
        + "Check your eBay connection, then try publishing again.",
    );
    expect(setup.cause).toBe(failure);
  });

  it("propagates a token or infrastructure failure instead of blaming the eBay connection", async () => {
    // Reaching the Account API first requires `getAccessToken`, which reads the
    // connection row through Supabase, decrypts the refresh token with
    // EBAY_TOKEN_ENC_KEY, and checks EBAY_CLIENT_ID/EBAY_CLIENT_SECRET — all
    // BEFORE one eBay GET is issued. An encryption-key rotation or a degraded
    // Supabase is a SnapList fault; answering "check your eBay connection"
    // invites a reconnect that rotates `connection_generation`, wipes
    // `policy_location_bindings`, and forces re-consent for nothing. Only a
    // failure eBay itself produced may become the seller-facing outcome.
    const tokenFailure = new Error(
      "Failed to decrypt the stored eBay refresh token: EBAY_TOKEN_ENC_KEY is invalid.",
    );

    await expect(
      ensureEbayPolicyLocationBinding({
        marketplaceId: "EBAY_US",
        adapter: {
          async discoverPolicyLocationCandidates() {
            throw tokenFailure;
          },
        },
        store: fakeStore(),
      }),
    ).rejects.toBe(tokenFailure);
  });

  it("propagates a binding-store write failure instead of blaming the eBay connection", async () => {
    // `save_ebay_policy_location_binding` failing (42501 when the server RPC
    // auth config is unprovisioned, a degraded Supabase) is a SnapList fault.
    // Reporting it as `unavailable` tells the seller to check their eBay
    // connection, and the reconnect that advice invites rotates
    // `connection_generation`, wipes their bindings, and forces re-consent.
    const store = fakeStore();
    const writeFailure = new Error(
      "Failed to save eBay policy setup: permission denied for function "
        + "save_ebay_policy_location_binding",
    );
    store.saveBinding = async () => {
      throw writeFailure;
    };

    await expect(
      ensureEbayPolicyLocationBinding({
        marketplaceId: "EBAY_US",
        adapter: discoveringAdapter(candidatesFor("seller-a")),
        store,
      }),
    ).rejects.toBe(writeFailure);
  });

  it("propagates the connection-changed fence instead of blaming the eBay connection", async () => {
    const store = fakeStore();
    const readConnectionContext = store.readConnectionContext.bind(store);
    let reads = 0;
    store.readConnectionContext = async () => {
      reads += 1;
      return reads === 1
        ? readConnectionContext()
        : {
            accountGeneration: ACCOUNT_GENERATION,
            connectionGeneration: NEXT_CONNECTION_GENERATION,
          };
    };

    await expect(
      ensureEbayPolicyLocationBinding({
        marketplaceId: "EBAY_US",
        adapter: discoveringAdapter(candidatesFor("seller-a")),
        store,
      }),
    ).rejects.toThrow("The eBay connection changed during policy discovery.");
    expect(store.saved).toEqual([]);
  });

  it("reports a missing connection without calling eBay", async () => {
    const adapter = discoveringAdapter(candidatesFor("seller-a"));
    const setup = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter,
      store: fakeStore({ connectionGeneration: null }),
    });

    expect(setup.state).toBe("notConnected");
    expect(adapter.calls).toEqual([]);
    expect(setup.message).toBe(
      "Connect your eBay account before publishing to eBay.",
    );
  });

  it("reports an unavailable read when the adapter cannot reach the Account API", async () => {
    const setup = await ensureEbayPolicyLocationBinding({
      marketplaceId: "EBAY_US",
      adapter: {},
      store: fakeStore(),
    });

    expect(setup.state).toBe("unavailable");
    expect(setup.binding).toBeNull();
  });
});
