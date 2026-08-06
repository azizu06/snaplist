import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import type { EbayPolicyLocationBinding } from "./policy-location-contract";
import { createSupabaseEbayPolicyLocationBindingStore } from "./policy-location-store";

const ACCOUNT_GENERATION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONNECTION_GENERATION = "11111111-1111-4111-8111-111111111111";

const BINDING: EbayPolicyLocationBinding = {
  state: "ready",
  marketplaceId: "EBAY_US",
  connectionGeneration: CONNECTION_GENERATION,
  fulfillmentPolicy: {
    state: "bound",
    selectedId: "fulfillment-1",
    candidates: [
      { id: "fulfillment-1", label: "Standard", providerDefault: false },
    ],
  },
  paymentPolicy: {
    state: "bound",
    selectedId: "payment-1",
    candidates: [
      { id: "payment-1", label: "Managed", providerDefault: false },
    ],
  },
  returnPolicy: {
    state: "bound",
    selectedId: "return-1",
    candidates: [
      { id: "return-1", label: "30 days", providerDefault: false },
    ],
  },
  inventoryLocation: {
    state: "bound",
    selectedId: "location-1",
    candidates: [
      { id: "location-1", label: "Home", providerDefault: false },
    ],
  },
  discoveredAt: "2026-07-22T22:30:00.000Z",
};

function client(input?: {
  row?: Record<string, unknown> | null;
  rpcData?: unknown;
  rpcError?: { message: string } | null;
}) {
  const maybeSingle = vi.fn(async () => ({
    data:
      input && "row" in input
        ? input.row
        : {
            account_generation: ACCOUNT_GENERATION,
            connection_generation: CONNECTION_GENERATION,
          },
    error: null,
  }));
  const query = {
    select: vi.fn(() => query),
    maybeSingle,
  };
  const from = vi.fn(() => query);
  const rpc = vi.fn(async () => ({
    data: input?.rpcData ?? BINDING,
    error: input?.rpcError ?? null,
  }));
  return {
    supabase: { from, rpc } as unknown as SupabaseClient,
    from,
    query,
    rpc,
  };
}

describe("createSupabaseEbayPolicyLocationBindingStore", () => {
  it("reads the RLS-owned connection generations and saves through the narrow RPC", async () => {
    const mock = client();
    const store = createSupabaseEbayPolicyLocationBindingStore(mock.supabase);

    await expect(store.readConnectionContext()).resolves.toEqual({
      accountGeneration: ACCOUNT_GENERATION,
      connectionGeneration: CONNECTION_GENERATION,
    });
    await expect(store.saveBinding(BINDING)).resolves.toEqual(BINDING);

    expect(mock.from).toHaveBeenCalledWith("ebay_connections");
    expect(mock.query.select).toHaveBeenCalledWith(
      "account_generation, connection_generation",
    );
    expect(mock.rpc).toHaveBeenCalledWith(
      "save_ebay_policy_location_binding",
      {
        p_marketplace_id: "EBAY_US",
        p_connection_generation: CONNECTION_GENERATION,
        p_binding: BINDING,
      },
    );
  });

  it("reads the stored binding for one marketplace with its connection generation", async () => {
    const mock = client({
      row: {
        connection_generation: CONNECTION_GENERATION,
        policy_location_bindings: { EBAY_US: BINDING },
      },
    });
    const store = createSupabaseEbayPolicyLocationBindingStore(mock.supabase);

    await expect(store.readStoredBinding("EBAY_US")).resolves.toEqual({
      connectionGeneration: CONNECTION_GENERATION,
      binding: BINDING,
    });
    expect(mock.query.select).toHaveBeenCalledWith(
      "connection_generation, policy_location_bindings",
    );
  });

  it("reports no stored binding for a marketplace the connection has never bound", async () => {
    const mock = client({
      row: {
        connection_generation: CONNECTION_GENERATION,
        policy_location_bindings: { EBAY_GB: BINDING },
      },
    });
    const store = createSupabaseEbayPolicyLocationBindingStore(mock.supabase);

    await expect(store.readStoredBinding("EBAY_US")).resolves.toEqual({
      connectionGeneration: CONNECTION_GENERATION,
      binding: undefined,
    });
  });

  it("reports a missing connection rather than an empty binding", async () => {
    const mock = client({ row: null });
    const store = createSupabaseEbayPolicyLocationBindingStore(mock.supabase);

    await expect(store.readStoredBinding("EBAY_US")).resolves.toBeNull();
  });

  it("rejects database results outside the display-safe binding contract", async () => {
    const mock = client({
      rpcData: {
        ...BINDING,
        description: "private provider description",
      },
    });
    const store = createSupabaseEbayPolicyLocationBindingStore(mock.supabase);

    await expect(store.saveBinding(BINDING)).rejects.toThrow();
  });
});
