import { describe, expect, it } from "vitest";
import {
  discoverAndBindEbayPolicyLocation,
  type EbayPolicyLocationBinding,
  type EbayPolicyLocationBindingStore,
  type EbayPolicyLocationDiscoveryAdapter,
} from "./policy-location-discovery";

const GENERATION_A = "11111111-1111-4111-8111-111111111111";
const GENERATION_B = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_GENERATION_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ACCOUNT_GENERATION_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function candidate(id: string, label: string) {
  return { id, label, providerDefault: false };
}

function fixture(prefix: string) {
  return {
    fulfillmentPolicies: [candidate(`${prefix}-fulfillment`, `${prefix} shipping`)],
    paymentPolicies: [candidate(`${prefix}-payment`, `${prefix} payment`)],
    returnPolicies: [candidate(`${prefix}-return`, `${prefix} returns`)],
    inventoryLocations: [candidate(`${prefix}-location`, `${prefix} warehouse`)],
  };
}

class TenantStore implements EbayPolicyLocationBindingStore {
  binding: EbayPolicyLocationBinding | null = null;

  constructor(
    private readonly accountGeneration: string,
    private connectionGeneration: string,
  ) {}

  reconnect(connectionGeneration: string) {
    this.connectionGeneration = connectionGeneration;
  }

  async readConnectionContext() {
    return {
      accountGeneration: this.accountGeneration,
      connectionGeneration: this.connectionGeneration,
    };
  }

  async saveBinding(binding: EbayPolicyLocationBinding) {
    this.binding = binding;
    return binding;
  }
}

function fixtureAdapter(
  expectedAccountGeneration: string,
  values: ReturnType<typeof fixture>,
): EbayPolicyLocationDiscoveryAdapter {
  return {
    async readCandidates(input) {
      expect(input).toEqual({
        marketplaceId: "EBAY_US",
        accountGeneration: expectedAccountGeneration,
      });
      return values;
    },
  };
}

describe("discoverAndBindEbayPolicyLocation", () => {
  it("keeps two sellers' unique policy and location fixtures disjoint", async () => {
    const sellerA = new TenantStore(ACCOUNT_GENERATION_A, GENERATION_A);
    const sellerB = new TenantStore(ACCOUNT_GENERATION_B, GENERATION_B);

    const [bindingA, bindingB] = await Promise.all([
      discoverAndBindEbayPolicyLocation({
        marketplaceId: "EBAY_US",
        adapter: fixtureAdapter(ACCOUNT_GENERATION_A, fixture("seller-a")),
        store: sellerA,
        now: () => Date.parse("2026-07-22T22:30:00Z"),
      }),
      discoverAndBindEbayPolicyLocation({
        marketplaceId: "EBAY_US",
        adapter: fixtureAdapter(ACCOUNT_GENERATION_B, fixture("seller-b")),
        store: sellerB,
        now: () => Date.parse("2026-07-22T22:31:00Z"),
      }),
    ]);

    expect(bindingA).toMatchObject({
      state: "ready",
      marketplaceId: "EBAY_US",
      connectionGeneration: GENERATION_A,
      fulfillmentPolicy: { state: "bound", selectedId: "seller-a-fulfillment" },
      paymentPolicy: { state: "bound", selectedId: "seller-a-payment" },
      returnPolicy: { state: "bound", selectedId: "seller-a-return" },
      inventoryLocation: { state: "bound", selectedId: "seller-a-location" },
    });
    expect(bindingB).toMatchObject({
      state: "ready",
      marketplaceId: "EBAY_US",
      connectionGeneration: GENERATION_B,
      fulfillmentPolicy: { state: "bound", selectedId: "seller-b-fulfillment" },
      paymentPolicy: { state: "bound", selectedId: "seller-b-payment" },
      returnPolicy: { state: "bound", selectedId: "seller-b-return" },
      inventoryLocation: { state: "bound", selectedId: "seller-b-location" },
    });
    expect(sellerA.binding).toEqual(bindingA);
    expect(sellerB.binding).toEqual(bindingB);
    expect(JSON.stringify(bindingA)).not.toContain("seller-b");
    expect(JSON.stringify(bindingB)).not.toContain("seller-a");
  });

  it("returns stable setup and selection states instead of guessing", async () => {
    const noSetup = new TenantStore(ACCOUNT_GENERATION_A, GENERATION_A);
    const ambiguous = new TenantStore(ACCOUNT_GENERATION_B, GENERATION_B);
    const multiple = {
      fulfillmentPolicies: [candidate("fulfillment-1", "Ground"), candidate("fulfillment-2", "Express")],
      paymentPolicies: [candidate("payment-1", "Managed"), candidate("payment-2", "Pickup")],
      returnPolicies: [candidate("return-1", "30 days"), candidate("return-2", "60 days")],
      inventoryLocations: [candidate("location-1", "Home"), candidate("location-2", "Warehouse")],
    };

    const setupResult = await discoverAndBindEbayPolicyLocation({
      marketplaceId: "EBAY_US",
      adapter: fixtureAdapter(ACCOUNT_GENERATION_A, {
        fulfillmentPolicies: [],
        paymentPolicies: [],
        returnPolicies: [],
        inventoryLocations: [],
      }),
      store: noSetup,
    });
    const selectionResult = await discoverAndBindEbayPolicyLocation({
      marketplaceId: "EBAY_US",
      adapter: fixtureAdapter(ACCOUNT_GENERATION_B, multiple),
      store: ambiguous,
    });

    expect(setupResult).toMatchObject({
      state: "setupRequired",
      fulfillmentPolicy: { state: "setupRequired", selectedId: null, candidates: [] },
      paymentPolicy: { state: "setupRequired", selectedId: null, candidates: [] },
      returnPolicy: { state: "setupRequired", selectedId: null, candidates: [] },
      inventoryLocation: { state: "setupRequired", selectedId: null, candidates: [] },
    });
    expect(selectionResult).toMatchObject({
      state: "selectionRequired",
      fulfillmentPolicy: { state: "selectionRequired", selectedId: null },
      paymentPolicy: { state: "selectionRequired", selectedId: null },
      returnPolicy: { state: "selectionRequired", selectedId: null },
      inventoryLocation: { state: "selectionRequired", selectedId: null },
    });
    expect(selectionResult.fulfillmentPolicy.candidates).toEqual(
      multiple.fulfillmentPolicies,
    );
  });

  it("automatically binds the sole provider-declared default", async () => {
    const store = new TenantStore(ACCOUNT_GENERATION_A, GENERATION_A);
    const defaults = fixture("seller-a");
    defaults.fulfillmentPolicies = [
      candidate("fulfillment-standard", "Standard"),
      {
        ...candidate("fulfillment-default", "Preferred"),
        providerDefault: true,
      },
    ];

    const result = await discoverAndBindEbayPolicyLocation({
      marketplaceId: "EBAY_US",
      adapter: fixtureAdapter(ACCOUNT_GENERATION_A, defaults),
      store,
    });

    expect(result.state).toBe("ready");
    expect(result.fulfillmentPolicy).toMatchObject({
      state: "bound",
      selectedId: "fulfillment-default",
    });
  });

  it("rejects discovery completed after the seller reconnects", async () => {
    const store = new TenantStore(ACCOUNT_GENERATION_A, GENERATION_A);
    const adapter: EbayPolicyLocationDiscoveryAdapter = {
      async readCandidates() {
        store.reconnect(GENERATION_B);
        return fixture("seller-a");
      },
    };

    await expect(
      discoverAndBindEbayPolicyLocation({
        marketplaceId: "EBAY_US",
        adapter,
        store,
      }),
    ).rejects.toThrow("eBay connection changed during policy discovery");
    expect(store.binding).toBeNull();
  });

  it("rejects adapter candidates carrying data outside the public contract", async () => {
    const store = new TenantStore(ACCOUNT_GENERATION_A, GENERATION_A);
    const unsafe = fixture("seller-a");
    unsafe.fulfillmentPolicies = [
      {
        ...candidate("fulfillment-1", "Standard"),
        description: "private seller note",
      } as ReturnType<typeof candidate>,
    ];

    await expect(
      discoverAndBindEbayPolicyLocation({
        marketplaceId: "EBAY_US",
        adapter: fixtureAdapter(ACCOUNT_GENERATION_A, unsafe),
        store,
      }),
    ).rejects.toThrow();
    expect(store.binding).toBeNull();
  });
});
