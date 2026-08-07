import { describe, expect, it } from "vitest";
import { readEbayPolicyLocationSettingsHint } from "./policy-location-setup";
import type { EbayPolicyLocationSetupStore } from "./policy-location-setup";
import type {
  EbayPolicyLocationBinding,
  EbayPolicyLocationChoice,
} from "./policy-location-contract";

const MARKETPLACE = "EBAY_US";
const CONNECTION_GENERATION = "11111111-1111-4111-8111-111111111111";
const RETIRED_CONNECTION_GENERATION = "22222222-2222-4222-8222-222222222222";

function candidate(id: string) {
  return { id, label: id, providerDefault: false };
}

const bound = (kind: string): EbayPolicyLocationChoice => ({
  state: "bound",
  selectedId: `seller-${kind}`,
  candidates: [candidate(`seller-${kind}`)],
});

const absent: EbayPolicyLocationChoice = {
  state: "setupRequired",
  selectedId: null,
  candidates: [],
};

const ambiguous = (kind: string): EbayPolicyLocationChoice => ({
  state: "selectionRequired",
  selectedId: null,
  candidates: [candidate(`seller-${kind}-a`), candidate(`seller-${kind}-b`)],
});

function binding(
  overrides: Partial<EbayPolicyLocationBinding> = {},
): EbayPolicyLocationBinding {
  const base = {
    state: "ready" as const,
    marketplaceId: MARKETPLACE,
    connectionGeneration: CONNECTION_GENERATION,
    fulfillmentPolicy: bound("fulfillment"),
    paymentPolicy: bound("payment"),
    returnPolicy: bound("return"),
    inventoryLocation: bound("location"),
    discoveredAt: "2026-08-06T00:00:00.000Z",
  };
  return { ...base, ...overrides } as EbayPolicyLocationBinding;
}

/**
 * A store that answers the stored read and FAILS every other capability. The
 * Settings read may only touch what is already persisted for this tenant, so a
 * discovery or write call here is a test failure rather than a silent eBay
 * Account API request on a Settings render.
 */
function storeWith(
  stored: unknown,
  connectionGeneration: string | null = CONNECTION_GENERATION,
): EbayPolicyLocationSetupStore {
  return {
    async readStoredBinding() {
      if (connectionGeneration === null) return null;
      return { connectionGeneration, binding: stored };
    },
    async readConnectionContext() {
      throw new Error("Settings must not read the eBay connection context.");
    },
    async saveBinding() {
      throw new Error("Settings must not write a binding.");
    },
  };
}

describe("readEbayPolicyLocationSettingsHint", () => {
  it("reports no hint for a seller with no eBay connection", async () => {
    const hint = await readEbayPolicyLocationSettingsHint({
      marketplaceId: MARKETPLACE,
      store: storeWith(undefined, null),
    });

    expect(hint).toBeNull();
  });

  it("reports ready without a message for a complete usable binding", async () => {
    const hint = await readEbayPolicyLocationSettingsHint({
      marketplaceId: MARKETPLACE,
      store: storeWith(binding()),
    });

    expect(hint).toMatchObject({
      state: "ready",
      marketplaceId: MARKETPLACE,
      missing: [],
      ambiguous: [],
      message: null,
    });
  });

  it("names every family the seller's eBay account is missing", async () => {
    const hint = await readEbayPolicyLocationSettingsHint({
      marketplaceId: MARKETPLACE,
      store: storeWith(
        binding({
          state: "setupRequired",
          paymentPolicy: absent,
          returnPolicy: absent,
        }),
      ),
    });

    expect(hint?.state).toBe("setupRequired");
    expect(hint?.missing).toEqual(["paymentPolicy", "returnPolicy"]);
    expect(hint?.ambiguous).toEqual([]);
    expect(hint?.message).toBe(
      "Your eBay account has no payment policy or return policy. "
      + "Add them in eBay before you publish.",
    );
  });

  it("names a single missing family in the singular", async () => {
    const hint = await readEbayPolicyLocationSettingsHint({
      marketplaceId: MARKETPLACE,
      store: storeWith(
        binding({ state: "setupRequired", inventoryLocation: absent }),
      ),
    });

    expect(hint?.missing).toEqual(["inventoryLocation"]);
    expect(hint?.message).toBe(
      "Your eBay account has no inventory location. "
      + "Add it in eBay before you publish.",
    );
  });

  it("reports the families SnapList must not choose between", async () => {
    const hint = await readEbayPolicyLocationSettingsHint({
      marketplaceId: MARKETPLACE,
      store: storeWith(
        binding({
          state: "selectionRequired",
          fulfillmentPolicy: ambiguous("fulfillment"),
        }),
      ),
    });

    expect(hint?.state).toBe("selectionRequired");
    expect(hint?.ambiguous).toEqual(["fulfillmentPolicy"]);
    expect(hint?.missing).toEqual([]);
    expect(hint?.message).toBe(
      "Your eBay account has more than one shipping policy, and SnapList cannot "
      + "choose for you. Keep one usable option in eBay before you publish.",
    );
  });

  it.each([
    ["nothing is stored for this marketplace", undefined],
    ["the stored binding is JSON null", null],
  ])(
    "says nothing to a connected seller who has never published when %s",
    async (_label, stored) => {
      // Bindings come only from publish-time discovery, so this is every
      // seller between eBay OAuth and their first publish. A message here is
      // a warning triangle on an account SnapList has found nothing wrong
      // with, which is the inversion issue #694 exists to prevent.
      const hint = await readEbayPolicyLocationSettingsHint({
        marketplaceId: MARKETPLACE,
        store: storeWith(stored),
      });

      expect(hint?.state).toBe("notChecked");
      expect(hint?.message).toBeNull();
      expect(hint?.missing).toEqual([]);
      expect(hint?.ambiguous).toEqual([]);
    },
  );

  it.each([
    ["unparseable", { state: "ready" }],
    ["for another marketplace", binding({ marketplaceId: "EBAY_GB" })],
  ])(
    "asks a connected seller to check eBay when the stored binding is %s",
    async (_label, stored) => {
      const hint = await readEbayPolicyLocationSettingsHint({
        marketplaceId: MARKETPLACE,
        store: storeWith(stored),
      });

      expect(hint?.state).toBe("notChecked");
      expect(hint?.missing).toEqual([]);
      expect(hint?.ambiguous).toEqual([]);
      expect(hint?.message).toBe(
        "SnapList has not read your eBay shipping, payment, and return "
        + "policies or your inventory location yet. Check that your eBay "
        + "account has one of each before you publish.",
      );
    },
  );

  it("treats a binding from a retired connection as not checked", async () => {
    const hint = await readEbayPolicyLocationSettingsHint({
      marketplaceId: MARKETPLACE,
      store: storeWith(
        binding({ connectionGeneration: RETIRED_CONNECTION_GENERATION }),
      ),
    });

    expect(hint?.state).toBe("notChecked");
  });

  it("points a US seller at the eBay page that owns business policies", async () => {
    const hint = await readEbayPolicyLocationSettingsHint({
      marketplaceId: MARKETPLACE,
      store: storeWith(binding({ state: "setupRequired", paymentPolicy: absent })),
    });

    expect(hint?.helpUrl).toBe(
      "https://www.bizpolicy.ebay.com/businesspolicy/manage",
    );
  });

  it("omits a help link for a marketplace SnapList has no verified page for", async () => {
    const hint = await readEbayPolicyLocationSettingsHint({
      marketplaceId: "EBAY_GB",
      store: storeWith(
        binding({
          marketplaceId: "EBAY_GB",
          state: "setupRequired",
          paymentPolicy: absent,
        }),
      ),
    });

    expect(hint?.state).toBe("setupRequired");
    expect(hint?.helpUrl).toBeNull();
  });
});
