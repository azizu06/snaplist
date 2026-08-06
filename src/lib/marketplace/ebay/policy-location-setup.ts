import {
  ebayPolicyLocationBindingSchema,
  type EbayPolicyLocationBinding,
  type EbayPolicyLocationCandidates,
} from "./policy-location-contract";
import {
  discoverAndBindEbayPolicyLocation,
  type EbayPolicyLocationBindingStore,
} from "./policy-location-discovery";
import { EbayApiError } from "./types";

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

export const EBAY_POLICY_SETUP_NOT_CHECKED_MESSAGE =
  "SnapList has not read your eBay shipping, payment, and return policies yet. "
  + "Check that your eBay account has one of each before you publish.";

/**
 * Where the seller fixes this on eBay. Business policies live on a per-site
 * host, so a link is offered only for a marketplace whose page SnapList has
 * actually verified. Every other marketplace gets the same named families with
 * no link rather than a guessed URL that could send a seller to a dead page.
 */
const POLICY_HELP_URLS: Record<string, string> = {
  EBAY_US: "https://www.bizpolicy.ebay.com/businesspolicy/manage",
};

export const EBAY_POLICY_SETUP_UNAVAILABLE_MESSAGE =
  "SnapList could not read your eBay shipping, payment, and return policies. "
  + "Check your eBay connection, then try publishing again.";

/**
 * Tags a throw that is BOTH from the adapter call that reads the seller's own
 * eBay account AND produced by eBay itself (`EbayApiError` — a non-2xx answer
 * from the Account/Inventory API, or from the token endpoint rejecting the
 * refresh grant). Only that combination may become the seller-facing
 * `unavailable` outcome, because only that combination describes something on
 * eBay's side.
 *
 * Origin alone is too coarse. The adapter call also mints the access token
 * first, and `getAccessToken` reads the connection row through Supabase,
 * decrypts it with EBAY_TOKEN_ENC_KEY, and checks EBAY_CLIENT_ID/SECRET before
 * the first Account API GET. Discovery around it likewise reads the connection
 * row, re-checks the generation fence, and writes the binding through an RPC.
 * Those are SnapList faults. Flattening them into "check your eBay connection"
 * invites the seller to reconnect, and a reconnect rotates
 * `connection_generation`, wipes `policy_location_bindings`, and forces
 * re-consent — a destructive act induced by our own key rotation or database
 * failure, with no 5xx and no server log to show for it. So the discriminator
 * is where the error came from and who produced it, never what its message says.
 */
class EbayPolicyAccountReadError extends Error {
  constructor(readonly readCause: unknown) {
    super("Reading the seller's eBay policies and locations failed.", {
      cause: readCause,
    });
    this.name = "EbayPolicyAccountReadError";
  }
}

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
        readCandidates: async (request) => {
          try {
            return await readCandidates.call(input.adapter, request);
          } catch (cause) {
            // Wrap ONLY what eBay itself refused. A token-mint or other
            // infrastructure failure inside the same call keeps its own
            // identity and propagates, so the caller answers 500 and logs it.
            if (!(cause instanceof EbayApiError)) throw cause;
            throw new EbayPolicyAccountReadError(cause);
          }
        },
      },
      store: input.store,
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    // Anything that is not an eBay account read is ours: rethrow it so the
    // caller raises a plain internal error, answers 500, and logs it — the same
    // treatment `readStoredBinding`'s own failure already gets above.
    if (!(error instanceof EbayPolicyAccountReadError)) throw error;
    return {
      state: "unavailable",
      marketplaceId,
      message: EBAY_POLICY_SETUP_UNAVAILABLE_MESSAGE,
      binding: null,
      // The ORIGINAL adapter error, so `isEbayAuthError` can still recognise an
      // expired grant behind this outcome and offer the reconnect message.
      cause: error.readCause,
    };
  }

  return setupFromBinding(discovered, marketplaceId);
}

export type EbayPolicySetupFamily = PartKey;

export type EbayPolicyLocationSettingsHintState =
  /** A usable binding governs this marketplace and connection. */
  | "ready"
  /** The seller's eBay account is missing one or more required families. */
  | "setupRequired"
  /** The seller has several usable options; SnapList must not guess. */
  | "selectionRequired"
  /**
   * Nothing publishable is stored for this marketplace and connection yet.
   * SnapList cannot name a family without reading the seller's eBay account,
   * and that read belongs to publish, not to a Settings render.
   */
  | "notChecked";

export interface EbayPolicyLocationSettingsHint {
  state: EbayPolicyLocationSettingsHintState;
  marketplaceId: string;
  /** Families eBay reported none of. Empty unless `setupRequired`. */
  missing: EbayPolicySetupFamily[];
  /** Families with several usable options. Empty unless `selectionRequired`. */
  ambiguous: EbayPolicySetupFamily[];
  /** Seller-facing explanation; `null` only when the state is `ready`. */
  message: string | null;
  /** The eBay page that owns these families, when SnapList has verified one. */
  helpUrl: string | null;
}

/**
 * What Settings may say about the seller's eBay policy setup BEFORE they try to
 * publish (issue #694).
 *
 * This reads only what publish already persisted for this tenant. It never
 * calls the eBay Account API, because a Settings render is not a publish and
 * must not spend the seller's eBay rate budget or block on eBay being up. That
 * is also why an absent, unparseable, foreign-marketplace, or retired-
 * generation binding reports `notChecked` instead of guessing: publish's
 * discovery is the only thing that can name a family, and it has not run.
 *
 * Returning `null` for a tenant with no eBay connection is deliberate. The
 * connect affordance already owns that state, so there is no hint shape a
 * disconnected seller could be shown by accident.
 */
export async function readEbayPolicyLocationSettingsHint(input: {
  marketplaceId: string;
  store: Pick<EbayPolicyLocationSetupStore, "readStoredBinding">;
}): Promise<EbayPolicyLocationSettingsHint | null> {
  const { marketplaceId } = input;
  const stored = await input.store.readStoredBinding(marketplaceId);
  if (!stored) return null;

  const helpUrl = POLICY_HELP_URLS[marketplaceId] ?? null;
  const empty: Omit<EbayPolicyLocationSettingsHint, "state" | "message"> = {
    marketplaceId,
    missing: [],
    ambiguous: [],
    helpUrl,
  };

  if (usableStoredBinding(stored.binding, marketplaceId, stored.connectionGeneration)) {
    return { ...empty, state: "ready", message: null };
  }

  // The same parse the publish path uses, minus the readiness demand: a binding
  // that parses and belongs to this marketplace and connection still carries
  // eBay's own answer about which families exist, even when it cannot publish.
  const parsed = ebayPolicyLocationBindingSchema.safeParse(stored.binding);
  if (
    !parsed.success
    || parsed.data.marketplaceId !== marketplaceId
    || parsed.data.connectionGeneration !== stored.connectionGeneration
  ) {
    return { ...empty, state: "notChecked", message: EBAY_POLICY_SETUP_NOT_CHECKED_MESSAGE };
  }

  const ambiguous = PART_KEYS.filter(
    (key) => parsed.data[key].state === "selectionRequired",
  );
  if (ambiguous.length > 0) {
    return {
      state: "selectionRequired",
      marketplaceId,
      missing: [],
      ambiguous,
      message:
        `Your eBay account has more than one ${labelList(ambiguous)} for `
        + `${marketplaceId}, and SnapList cannot choose for you. Keep one usable `
        + "option in eBay before you publish.",
      helpUrl,
    };
  }

  const missing = PART_KEYS.filter(
    (key) => parsed.data[key].state === "setupRequired",
  );
  if (missing.length === 0) {
    // Every family is bound yet the binding was not usable above, so the only
    // thing left that can differ is a shape publish would re-discover.
    return { ...empty, state: "notChecked", message: EBAY_POLICY_SETUP_NOT_CHECKED_MESSAGE };
  }
  return {
    state: "setupRequired",
    marketplaceId,
    missing,
    ambiguous: [],
    message:
      `Your eBay account has no ${labelList(missing)} for ${marketplaceId}. `
      + `Add ${missing.length > 1 ? "them" : "it"} in eBay before you publish.`,
    helpUrl,
  };
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
