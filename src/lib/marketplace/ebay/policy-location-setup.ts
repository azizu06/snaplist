import {
  ebayPolicyLocationBindingSchema,
  type EbayPolicyLocationBinding,
  type EbayPolicyLocationCandidates,
} from "./policy-location-contract";
import {
  discoverAndBindEbayPolicyLocation,
  type EbayPolicyLocationBindingStore,
} from "./policy-location-discovery";

/**
 * Per-connection eBay policy/location setup (issue #47).
 *
 * Business policies and inventory locations belong to the eBay ACCOUNT that
 * created them, so a process-wide policy id would submit the first connected
 * seller's ids on a second seller's offer and eBay would reject it. This module
 * is the composition seam that turns the discovery primitives (issue #525) into
 * a self-healing binding: read what is stored for the seller's CURRENT
 * connection, and only when that is unusable read the seller's own account
 * through the adapter and persist the result under their RLS-owned row.
 *
 * Refresh discipline: discovery runs exactly when the stored binding cannot
 * govern this publish — absent, unparseable, for another marketplace, from a
 * retired connection generation, or not `ready`. A reconnect advances the
 * connection generation, so connecting a DIFFERENT eBay account always
 * re-discovers. There is deliberately no time-based refresh: re-reading a
 * working binding on a timer could flip a publishable seller to
 * `selectionRequired` the moment they add a second policy in eBay, which would
 * block a publish that eBay itself would still accept.
 *
 * Nothing here ever substitutes another seller's ids or an env global. When the
 * seller's own account cannot produce a usable binding, the result carries an
 * honest, plain-language message and the caller refuses to publish.
 */

export interface EbayPolicyLocationSetupStore
  extends EbayPolicyLocationBindingStore {
  /**
   * The binding stored for one marketplace plus the connection generation it
   * must match. `null` means no eBay connection exists for this tenant.
   */
  readStoredBinding(marketplaceId: string): Promise<{
    connectionGeneration: string;
    binding: unknown;
  } | null>;
}

/** The read-only capability this module needs from the eBay adapter seam. */
export interface EbayPolicyLocationDiscoveringAdapter {
  discoverPolicyLocationCandidates?(input: {
    marketplaceId: string;
    accountGeneration: string;
  }): Promise<EbayPolicyLocationCandidates>;
}

export type EbayPolicyLocationSetupState =
  /** A usable binding governs this marketplace and connection. */
  | "ready"
  /** The seller's eBay account is missing one or more required pieces. */
  | "setupRequired"
  /** The seller has several usable options; SnapList must not guess. */
  | "selectionRequired"
  /** No eBay connection for this tenant. */
  | "notConnected"
  /** The seller's own account could not be read right now. */
  | "unavailable";

export interface EbayPolicyLocationSetup {
  state: EbayPolicyLocationSetupState;
  marketplaceId: string;
  /** Seller-facing explanation; `null` only when the state is `ready`. */
  message: string | null;
  /** Present only when `ready`; never a fabricated or borrowed binding. */
  binding: EbayPolicyLocationBinding | null;
  /** The underlying failure behind `unavailable`, for server-side reporting. */
  cause?: unknown;
}

const PART_LABELS = {
  fulfillmentPolicy: "shipping policy",
  paymentPolicy: "payment policy",
  returnPolicy: "return policy",
  inventoryLocation: "inventory location",
} as const;

type PartKey = keyof typeof PART_LABELS;

const PART_KEYS = Object.keys(PART_LABELS) as PartKey[];

export const EBAY_POLICY_SETUP_NOT_CONNECTED_MESSAGE =
  "Connect your eBay account before publishing to eBay.";

export const EBAY_POLICY_SETUP_UNAVAILABLE_MESSAGE =
  "SnapList could not read your eBay shipping, payment, and return policies. "
  + "Check your eBay connection, then try publishing again.";

export async function ensureEbayPolicyLocationBinding(input: {
  marketplaceId: string;
  adapter: EbayPolicyLocationDiscoveringAdapter;
  store: EbayPolicyLocationSetupStore;
  now?: () => number;
}): Promise<EbayPolicyLocationSetup> {
  const { marketplaceId } = input;
  const stored = await input.store.readStoredBinding(marketplaceId);
  if (!stored) {
    return {
      state: "notConnected",
      marketplaceId,
      message: EBAY_POLICY_SETUP_NOT_CONNECTED_MESSAGE,
      binding: null,
    };
  }

  const usable = usableStoredBinding(
    stored.binding,
    marketplaceId,
    stored.connectionGeneration,
  );
  if (usable) {
    return { state: "ready", marketplaceId, message: null, binding: usable };
  }

  const readCandidates = input.adapter.discoverPolicyLocationCandidates;
  if (!readCandidates) {
    return {
      state: "unavailable",
      marketplaceId,
      message: EBAY_POLICY_SETUP_UNAVAILABLE_MESSAGE,
      binding: null,
    };
  }

  let discovered: EbayPolicyLocationBinding;
  try {
    discovered = await discoverAndBindEbayPolicyLocation({
      marketplaceId,
      adapter: {
        readCandidates: (request) =>
          readCandidates.call(input.adapter, request),
      },
      store: input.store,
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (cause) {
    return {
      state: "unavailable",
      marketplaceId,
      message: EBAY_POLICY_SETUP_UNAVAILABLE_MESSAGE,
      binding: null,
      cause,
    };
  }

  return setupFromBinding(discovered, marketplaceId);
}

function setupFromBinding(
  binding: EbayPolicyLocationBinding,
  marketplaceId: string,
): EbayPolicyLocationSetup {
  if (binding.state === "ready") {
    return { state: "ready", marketplaceId, message: null, binding };
  }
  const missing = PART_KEYS.filter(
    (key) => binding[key].state === "setupRequired",
  );
  const ambiguous = PART_KEYS.filter(
    (key) => binding[key].state === "selectionRequired",
  );
  if (ambiguous.length > 0) {
    return {
      state: "selectionRequired",
      marketplaceId,
      message:
        `Your eBay account has more than one ${labelList(ambiguous)} for `
        + `${marketplaceId}, and SnapList cannot choose for you. Keep one usable `
        + "option in eBay, then try publishing again.",
      binding: null,
    };
  }
  return {
    state: "setupRequired",
    marketplaceId,
    message:
      `Your eBay account has no ${labelList(missing)} for ${marketplaceId}. `
      + `Add ${missing.length > 1 ? "them" : "it"} in eBay, then try publishing again.`,
    binding: null,
  };
}

/**
 * The stored binding may govern this publish only when it parses, targets THIS
 * marketplace, was discovered under the CURRENT connection generation, and
 * every part is bound. Anything else re-discovers rather than publishing with
 * a stale or foreign id.
 */
function usableStoredBinding(
  value: unknown,
  marketplaceId: string,
  connectionGeneration: string,
): EbayPolicyLocationBinding | null {
  const parsed = ebayPolicyLocationBindingSchema.safeParse(value);
  if (
    !parsed.success
    || parsed.data.state !== "ready"
    || parsed.data.marketplaceId !== marketplaceId
    || parsed.data.connectionGeneration !== connectionGeneration
  ) {
    return null;
  }
  return PART_KEYS.every((key) => parsed.data[key].state === "bound")
    ? parsed.data
    : null;
}

function labelList(keys: PartKey[]): string {
  const labels = keys.map((key) => PART_LABELS[key]);
  if (labels.length <= 1) return labels[0] ?? "business policy";
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}
