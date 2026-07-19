import { z } from "zod";

/**
 * Pricing pipeline contracts (see PRD "Pricing pipeline (behind a PricingProvider
 * interface)" and CONTEXT.md: Tier, Comp, Price recommendation, PricingProvider).
 *
 * Pricing is a *routing pipeline*, not a single source: an `ItemSignal` is routed
 * through ordered `PricingProvider`s; the first one that handles it wins. This
 * module defines only the seam (signal in, price recommendation out) — the real
 * tier implementations land in later slices.
 */

/**
 * The pricing tiers in PRD priority order. Each is one PricingProvider strategy
 * in the routing pipeline; "which tier fired" is a confidence-bearing fact that
 * the (separately built) confidence composite consumes.
 *
 *  1. isbn-lookup   — books/media via ISBN → structured catalog lookup. Highest
 *                     identification confidence; estimate-level pricing trust unless sold-backed.
 *  2. ebay-sold     — recognizable/identifiable item priced from eBay PUBLIC sold comps
 *                     (the strongest used signal: real completed sales). Slots above the
 *                     web-search tiers — sold beats asking (ADR-0001, issue #56).
 *  3. upc-aided-web — UPC decoded as an identification/query AID into the web-search
 *                     agent (never a price oracle; the barcode-tier split).
 *  4. branded-web   — recognizable branded item priced from real web comps.
 *  5. depreciation  — only retail found → retail × condition depreciation. Low confidence.
 *  6. llm-only      — ultimate fallback, LLM estimate. Lowest confidence.
 */
export const PRICING_TIERS = [
  "isbn-lookup",
  "ebay-sold",
  "upc-aided-web",
  "branded-web",
  "depreciation",
  "llm-only",
] as const;

/** A tier identifier — one strategy in the routing pipeline. */
export type PricingTier = (typeof PRICING_TIERS)[number];

export const pricingTierSchema = z.enum(PRICING_TIERS);

/**
 * The minimal router input: the signals extracted from an Item that decide which
 * tier should price it. Deliberately small and provider-agnostic — providers read
 * what they need and DECLINE (return null) when they can't handle a signal.
 */
export interface ItemSignal {
  /** Decoded ISBN (books/media). Routes to the structured ISBN lookup tier. */
  isbn?: string;
  /** Decoded UPC. An identification/query aid for the web-search tier, not a price source. */
  upc?: string;
  /** Resolved brand, e.g. "Sony". Brand + model implies a recognizable branded item. */
  brand?: string;
  /** Resolved model, e.g. "WH-1000XM4". */
  model?: string;
  /** Category, e.g. "electronics" / "books". Helps disambiguate tier and query. */
  category?: string;
  /** Whether condition was assessed at all. */
  conditionKnown?: boolean;
  /**
   * Assessed condition grade (e.g. "new" | "like-new" | "good" | "fair" | "poor")
   * when known. The depreciation tier applies a condition-specific factor to it.
   */
  condition?: string;
  /**
   * A retail price discovered for the item (e.g. surfaced by the web-search tier
   * when only retail — not resale — comps were found). Carried in the routing
   * context so the depreciation tier can compute retail × condition factor without
   * repeating the search. NOT consumed yet: nothing produces it, and it carries no
   * citation URL while depreciation results must cite checkable evidence (the
   * `sources` refine below) — so the tier runs its own bounded retail search until
   * the producer slice forwards the discovering source alongside the price.
   */
  retailPrice?: number;
  /** Free-form resolved product name (e.g. UPC-resolved title) to seed search queries. */
  resolvedName?: string;
  /**
   * Key specs the vision step surfaced (e.g. ["i7", "RTX 3060"]). Used ONLY to
   * NARROW the web-search query so comps cluster on the SAME configuration — an
   * identification/query aid, never a price source. Without them a multi-config
   * model (a laptop sold as i5/i7, 1660Ti/RTX) returns scattered comps and the
   * comp-agreement signal collapses toward zero.
   */
  specs?: string[];
}

/** A comparable price point / citation behind a price recommendation. */
export const priceSourceSchema = z.object({
  /** Canonical link to the comp or lookup record. Required — a source must be checkable. */
  url: z.string().min(1),
  /** Human-readable label (listing/page title). */
  title: z.string().optional(),
  /** What kind of source this is, e.g. "isbn-lookup" | "sold-comp" | "asking-comp". */
  kind: z.string().optional(),
});

export type PriceSource = z.infer<typeof priceSourceSchema>;

/**
 * A price recommendation. Always `{ suggested, range, confidence, sources[] }`
 * (never a bare number) and always user-editable. Carries the firing `tier` and
 * its `sources` as raw signal so the confidence composite (tier fired + comp
 * agreement + ID completeness) can be computed downstream WITHOUT this module
 * importing the confidence module.
 */
export const priceResultSchema = z
  .object({
    /** The single suggested price (the seller can override). */
    suggested: z.number().nonnegative(),
    /** The defensible used-price band. */
    range: z.object({
      min: z.number().nonnegative(),
      max: z.number().nonnegative(),
    }),
    /**
     * Composite-ready confidence in [0, 1]. A provider may emit a provisional
     * value; the canonical publish-eligibility gate recomputes it from signals later.
     */
    confidence: z.number().min(0).max(1),
    /** Cited comps / lookup records. May be empty for the LLM-only fallback. */
    sources: z.array(priceSourceSchema),
    /** Which tier produced this — a logged, confidence-bearing fact. */
    tier: pricingTierSchema,
    /**
     * The LLM model id that produced/extracted this price, when an LLM was
     * involved (e.g. the web tiers' comp extractor, resolved from
     * `PRICING_MODEL`). Deterministic tiers (isbn-lookup) leave it unset.
     * Logged for provenance (`prediction_logs.pricing_model`), mirroring the
     * listing_model precedent (#32).
     */
    model: z.string().optional(),
    /**
     * Judged comp agreement in [0, 1] (1 = comps in lockstep), reported by
     * comp-based tiers from their measured relative spread. The pipeline's
     * confidence composite consumes this so a SCATTERED sold set cannot ride
     * the sold-comp label into the tight (ready-to-publish) confidence tier.
     * Tiers with no comp set leave it unset.
     */
    compAgreement: z.number().min(0).max(1).optional(),
  })
  .refine((r) => r.range.min <= r.range.max, {
    message: "range.min must be <= range.max",
    path: ["range"],
  })
  .refine((r) => r.range.min <= r.suggested && r.suggested <= r.range.max, {
    message: "suggested must be within [range.min, range.max]",
    path: ["suggested"],
  })
  .refine((r) => r.tier === "llm-only" || r.sources.length > 0, {
    // Every tier except the LLM-only fallback must cite checkable evidence — a
    // high-confidence ISBN/web result with no sources violates the pricing contract.
    message: "sources must be non-empty for every tier except llm-only",
    path: ["sources"],
  });

export type PriceResult = z.infer<typeof priceResultSchema>;

/**
 * The interface every pricing strategy implements. A provider declares its `tier`
 * and either HANDLES an `ItemSignal` (returns a `PriceResult`) or DECLINES
 * (returns `null`) so the router falls through to the next provider.
 *
 * `canHandle` is an optional cheap pre-check; the router does not require it —
 * declining via a `null` from `price` is sufficient. Throwing from `price` is a
 * hard error (upstream failure), NOT a decline.
 */
export interface PricingProvider {
  /** The tier this provider implements. */
  readonly tier: PricingTier;
  /** Optional cheap guard; the router still treats a `null` from `price` as decline. */
  canHandle?(signal: ItemSignal): boolean;
  /** Price the signal, or return `null` to decline and let the router fall through. */
  price(signal: ItemSignal): Promise<PriceResult | null>;
}
