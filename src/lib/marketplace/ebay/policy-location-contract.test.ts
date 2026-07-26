import { describe, expect, it } from "vitest";
import { ebayPolicyLocationBindingSchema } from "./policy-location-contract";

const candidate = {
  id: "policy-1",
  label: "Standard policy",
  providerDefault: false,
};

function readyBinding() {
  const choice = {
    state: "bound" as const,
    selectedId: candidate.id,
    candidates: [candidate],
  };
  return {
    state: "ready" as const,
    marketplaceId: "EBAY_US",
    connectionGeneration: "11111111-1111-4111-8111-111111111111",
    fulfillmentPolicy: choice,
    paymentPolicy: choice,
    returnPolicy: choice,
    inventoryLocation: choice,
    discoveredAt: "2026-07-22T22:30:00.000Z",
  };
}

describe("ebayPolicyLocationBindingSchema", () => {
  it("accepts the stable public shape and rejects provider-private candidate data", () => {
    expect(ebayPolicyLocationBindingSchema.parse(readyBinding())).toEqual(
      readyBinding(),
    );

    const unsafe = readyBinding();
    unsafe.fulfillmentPolicy = {
      ...unsafe.fulfillmentPolicy,
      candidates: [
        {
          ...candidate,
          address: "private street",
          description: "private seller note",
        } as typeof candidate,
      ],
    };
    expect(() => ebayPolicyLocationBindingSchema.parse(unsafe)).toThrow();
  });
});
