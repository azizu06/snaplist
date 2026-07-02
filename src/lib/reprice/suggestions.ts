import type { SupabaseClient } from "@supabase/supabase-js";
import type { EbayAdapter } from "../marketplace/ebay";
import { marketplaceCurrency } from "../marketplace/ebay/map";
import { createNotification } from "../notifications";

/**
 * Reprice suggestions — the seller-facing data layer (issue #102).
 *
 * The cron sweep (sweep.ts) writes `reprice_suggestions`; this module is how
 * the seller reads and resolves them: list the pending ones for the dashboard
 * card, one-tap APPLY (revise the live eBay listing through the adapter, then
 * record the change), or DISMISS. Everything here runs on the caller's
 * USER-SCOPED client, so RLS pins tenancy — a foreign suggestion id is simply
 * not found.
 */

export interface RepriceSuggestionView {
  id: string;
  itemId: string;
  listingId: string;
  /** The listing's title (for the card); falls back to a generic label. */
  title: string;
  currentPrice: number;
  suggestedPrice: number;
  /** What one-tap apply will set: the suggestion clamped to the price floor. */
  targetPrice: number;
  range: { low: number; high: number };
  /** Signed percent (suggested vs current). */
  driftPct: number;
  confidence: number;
  tierFired: string;
  /** Cited fresh comps behind the suggestion. */
  sources: Array<{ url: string; title?: string; kind?: string }>;
  flooredToMinimum: boolean;
  createdAt: string;
}

interface SuggestionRow {
  id: string;
  item_id: string;
  listing_id: string;
  current_price: number | string;
  suggested_price: number | string;
  target_price: number | string;
  price_range: { low?: number; high?: number } | null;
  drift_pct: number | string;
  confidence: number | string;
  tier_fired: string;
  sources: unknown;
  floored_to_minimum: boolean | null;
  status: string;
  created_at: string;
  listings: { title: string | null; ebay_offer_id: string | null } | null;
}

const SELECT =
  "id, item_id, listing_id, current_price, suggested_price, target_price, price_range, drift_pct, confidence, tier_fired, sources, floored_to_minimum, status, created_at, listings (title, ebay_offer_id)" as const;

function toView(row: SuggestionRow): RepriceSuggestionView {
  const sources = Array.isArray(row.sources)
    ? (row.sources as RepriceSuggestionView["sources"])
    : [];
  return {
    id: row.id,
    itemId: row.item_id,
    listingId: row.listing_id,
    title: row.listings?.title?.trim() || "Untitled listing",
    currentPrice: Number(row.current_price),
    suggestedPrice: Number(row.suggested_price),
    targetPrice: Number(row.target_price),
    range: {
      low: Number(row.price_range?.low ?? row.suggested_price),
      high: Number(row.price_range?.high ?? row.suggested_price),
    },
    driftPct: Number(row.drift_pct),
    confidence: Number(row.confidence),
    tierFired: row.tier_fired,
    sources,
    flooredToMinimum: row.floored_to_minimum ?? false,
    createdAt: row.created_at,
  };
}

/** The seller's pending suggestions, newest first (RLS scopes to them). */
export async function listPendingRepriceSuggestions(
  supabase: SupabaseClient,
  limit = 10,
): Promise<RepriceSuggestionView[]> {
  const { data, error } = await supabase
    .from("reprice_suggestions")
    .select(SELECT)
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    throw new Error(`Failed to list reprice suggestions: ${error.message}`);
  }
  return ((data ?? []) as unknown as SuggestionRow[]).map(toView);
}

/** Typed, user-actionable failure for the apply path (safe to surface). */
export class RepriceApplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepriceApplyError";
  }
}

/** The currency every persisted price is denominated in (mirrors publish.ts). */
const PRICING_CURRENCY = "USD";

export interface ApplyRepriceOptions {
  /** Injectable env reader; defaults to process.env. */
  env?: () => Record<string, string | undefined>;
  /** Injectable clock (tests). */
  now?: () => Date;
}

/**
 * One-tap apply: revise the live eBay listing to the suggestion's target price
 * through the adapter, then record the change (suggestion → applied, the
 * seller's effective price, the listing's live price, a bell notification).
 *
 * The floor guard re-runs here — the seller may have raised the floor since
 * the sweep — so an apply can NEVER set a price below the CURRENT floor.
 */
export async function applyRepriceSuggestion(
  supabase: SupabaseClient,
  userId: string,
  suggestionId: string,
  adapter: EbayAdapter,
  options: ApplyRepriceOptions = {},
): Promise<{ appliedPrice: number }> {
  const env = options.env?.() ?? process.env;
  const now = options.now ?? (() => new Date());

  const { data, error } = await supabase
    .from("reprice_suggestions")
    .select(`${SELECT}, items (price_floor)`)
    .eq("id", suggestionId)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load suggestion: ${error.message}`);
  }
  const row = data as unknown as
    | (SuggestionRow & { items: { price_floor: number | string | null } | null })
    | null;
  if (!row) {
    throw new RepriceApplyError("Suggestion not found (or not yours).");
  }
  if (row.status !== "pending") {
    throw new RepriceApplyError("This suggestion has already been resolved.");
  }
  if (!row.listings?.ebay_offer_id) {
    throw new RepriceApplyError(
      "This listing has no eBay offer on record, so its price can't be revised automatically.",
    );
  }

  // Floor guard (belt to the sweep's clamp — the floor may have changed since).
  const floorRaw = row.items?.price_floor;
  const floor = floorRaw == null ? null : Number(floorRaw);
  let applyPrice = Number(row.target_price);
  if (floor != null && Number.isFinite(floor) && floor > 0) {
    applyPrice = Math.max(applyPrice, Math.round(floor * 100) / 100);
  }
  if (!Number.isFinite(applyPrice) || applyPrice <= 0) {
    throw new RepriceApplyError("The suggested price is not usable.");
  }

  // Same currency guard as publish/sweep: never relabel a USD amount.
  const currency = marketplaceCurrency(env.EBAY_MARKETPLACE_ID, env.EBAY_CURRENCY);
  if (!env.EBAY_CURRENCY && currency !== PRICING_CURRENCY) {
    throw new RepriceApplyError(
      `Repricing is computed in ${PRICING_CURRENCY} but the marketplace uses ${currency}; ` +
        "set EBAY_CURRENCY explicitly if your prices really are in that currency.",
    );
  }

  await adapter.revisePrice({
    sku: row.listing_id,
    offerId: row.listings.ebay_offer_id,
    price: { value: applyPrice.toFixed(2), currency },
  });

  // The revision is LIVE — record it. RLS re-pins every write to the caller.
  const nowIso = now().toISOString();
  const [suggestionWrite, itemWrite, listingWrite] = await Promise.all([
    supabase
      .from("reprice_suggestions")
      .update({ status: "applied", applied_price: applyPrice, resolved_at: nowIso })
      .eq("id", suggestionId)
      .eq("status", "pending"),
    supabase
      .from("items")
      .update({ price_override: applyPrice })
      .eq("id", row.item_id),
    supabase
      .from("listings")
      .update({ listed_price: applyPrice, last_priced_at: nowIso })
      .eq("id", row.listing_id),
  ]);
  const writeError =
    suggestionWrite.error ?? itemWrite.error ?? listingWrite.error;
  if (writeError) {
    // The eBay revision is live; surface loudly so the caller reconciles
    // instead of silently showing the old price.
    throw new Error(
      `Price revised on eBay but recording it failed: ${writeError.message}`,
    );
  }

  await createNotification(supabase, {
    userId,
    kind: "system",
    title: `Repriced “${row.listings.title?.trim() || "your listing"}” to $${applyPrice.toFixed(2)}`,
    body: "The new price is live on eBay.",
    href: `/listings/${row.listing_id}`,
    itemId: row.item_id,
    listingId: row.listing_id,
  });

  return { appliedPrice: applyPrice };
}

/** Dismiss a pending suggestion (RLS-scoped; resolving twice is a no-op). */
export async function dismissRepriceSuggestion(
  supabase: SupabaseClient,
  suggestionId: string,
  now: () => Date = () => new Date(),
): Promise<void> {
  const { error } = await supabase
    .from("reprice_suggestions")
    .update({ status: "dismissed", resolved_at: now().toISOString() })
    .eq("id", suggestionId)
    .eq("status", "pending");
  if (error) {
    throw new Error(`Failed to dismiss suggestion: ${error.message}`);
  }
}
