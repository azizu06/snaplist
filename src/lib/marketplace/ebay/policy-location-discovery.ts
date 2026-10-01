import {
  ebayPolicyLocationBindingSchema,
  ebayPolicyLocationCandidatesSchema,
  type EbayPolicyLocationBinding,
  type EbayPolicyLocationCandidate,
  type EbayPolicyLocationCandidates,
  type EbayPolicyLocationChoice,
} from "./policy-location-contract";

export type {
  EbayPolicyLocationBinding,
  EbayPolicyLocationCandidate,
  EbayPolicyLocationCandidates,
  EbayPolicyLocationChoice,
} from "./policy-location-contract";

export interface EbayPolicyLocationDiscoveryAdapter {
  readCandidates(input: {
    marketplaceId: string;
    accountGeneration: string;
  }): Promise<EbayPolicyLocationCandidates>;
}

export interface EbayPolicyLocationBindingStore {
  readConnectionContext(): Promise<{
    accountGeneration: string;
    connectionGeneration: string;
  } | null>;
  saveBinding(
    binding: EbayPolicyLocationBinding,
  ): Promise<EbayPolicyLocationBinding>;
}

/**
 * SnapList names the merchant location keys it creates with this prefix. A
 * seller with several inventory locations (their own warehouse plus the one
 * SnapList made) would otherwise be stuck on `selectionRequired` with no way to
 * choose in the app. Exactly one match is unambiguous and never touches the
 * seller's own locations; two or more still need the seller's choice.
 */
const SNAPLIST_LOCATION_KEY_PREFIX = "snaplist-";

function soleSnapListLocation(
  candidates: EbayPolicyLocationCandidate[],
): EbayPolicyLocationCandidate | null {
  const owned = candidates.filter((candidate) =>
    candidate.id.toLowerCase().startsWith(SNAPLIST_LOCATION_KEY_PREFIX),
  );
  return owned.length === 1 ? owned[0] : null;
}

function resolveChoice(
  candidates: EbayPolicyLocationCandidate[],
  options: { preferSnapListOwned?: boolean } = {},
): EbayPolicyLocationChoice {
  const [selected] = candidates;
  if (!selected) {
    return { state: "setupRequired", selectedId: null, candidates };
  }
  if (candidates.length > 1) {
    const defaults = candidates.filter((candidate) => candidate.providerDefault);
    if (defaults.length === 1) {
      return {
        state: "bound",
        selectedId: defaults[0].id,
        candidates,
      };
    }
    const owned = options.preferSnapListOwned
      ? soleSnapListLocation(candidates)
      : null;
    if (owned) {
      return { state: "bound", selectedId: owned.id, candidates };
    }
    return { state: "selectionRequired", selectedId: null, candidates };
  }
  return { state: "bound", selectedId: selected.id, candidates };
}

export async function discoverAndBindEbayPolicyLocation(input: {
  marketplaceId: string;
  adapter: EbayPolicyLocationDiscoveryAdapter;
  store: EbayPolicyLocationBindingStore;
  now?: () => number;
}): Promise<EbayPolicyLocationBinding> {
  const connection = await input.store.readConnectionContext();
  if (!connection) throw new Error("An eBay connection is required.");

  const candidates = ebayPolicyLocationCandidatesSchema.parse(
    await input.adapter.readCandidates({
      marketplaceId: input.marketplaceId,
      accountGeneration: connection.accountGeneration,
    }),
  );
  const choices = {
    fulfillmentPolicy: resolveChoice(candidates.fulfillmentPolicies),
    paymentPolicy: resolveChoice(candidates.paymentPolicies),
    returnPolicy: resolveChoice(candidates.returnPolicies),
    inventoryLocation: resolveChoice(candidates.inventoryLocations, {
      preferSnapListOwned: true,
    }),
  };
  const choiceStates = Object.values(choices).map((choice) => choice.state);
  const state = choiceStates.includes("selectionRequired")
    ? "selectionRequired"
    : choiceStates.includes("setupRequired")
      ? "setupRequired"
      : "ready";
  const binding = ebayPolicyLocationBindingSchema.parse({
    state,
    marketplaceId: input.marketplaceId,
    connectionGeneration: connection.connectionGeneration,
    ...choices,
    discoveredAt: new Date((input.now ?? Date.now)()).toISOString(),
  });
  const currentConnection = await input.store.readConnectionContext();
  if (
    !currentConnection
    || currentConnection.connectionGeneration
      !== connection.connectionGeneration
    || currentConnection.accountGeneration !== connection.accountGeneration
  ) {
    throw new Error("The eBay connection changed during policy discovery.");
  }
  return ebayPolicyLocationBindingSchema.parse(
    await input.store.saveBinding(binding),
  );
}
