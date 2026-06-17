import { coreComps, type EbaySoldComp } from "../pricing/providers/ebay-sold";
import { referenceItemSchema, type ReferenceItem } from "./types";

/**
 * Build REAL reference-corpus exemplars from harvested data — replacing the
 * hand-authored synthetic seed with grounded, real-market entries (the "harvest +
 * flywheel" corpus strategy).
 *
 * Two sources, both producing the same `ReferenceItem` shape so they flow through
 * the existing embed + upsert seed path (`seedReferenceCorpus`):
 *
 *  1. **eBay harvest** (`exemplarFromComps`) — turns the SAME parsed sold comps the
 *     pricing tier already fetches into a corpus row: real product identity, real
 *     used price (robust median via #1's `coreComps`), and a real listing TITLE as
 *     the few-shot style exemplar. Copyright-safe: we keep factual titles + facts,
 *     never another seller's creative description verbatim, and the sold price is
 *     NOT written into `content` (that would teach the generator to assert prices it
 *     can't verify — the honest-grounded-copy rule). Price lives in its own field
 *     for pricing corroboration.
 *
 *  2. **Flywheel** (`referenceItemFromListing`) — a listing SnapList itself generated
 *     and the seller APPROVED becomes a corpus row. This is the richest, fully-owned
 *     copy exemplar (no scraping, no copyright question), and it grows the corpus
 *     organically from real platform usage.
 */

/** Minimum priced comps to mint a harvested exemplar — below this it isn't real evidence. */
export const HARVEST_MIN_COMPS = 2;

/** The seed identity we harvested for: what we searched, not what we parsed. */
export interface HarvestQuery {
  category: string;
  brand?: string;
  model?: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** kebab slug for a stable, collision-resistant sourceRef. */
function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Stable dedupe key for a harvested product (re-harvest UPSERTs, never duplicates). */
export function harvestSourceRef(query: HarvestQuery): string {
  return ["harvest", query.category, query.brand, query.model]
    .filter((p): p is string => Boolean(p && p.trim()))
    .map(slug)
    .join("-");
}

/** Title-case a one-word condition for the factual blurb ("good" → "Good"). */
function titleCase(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** Compose a factual copy exemplar from a real title + optional condition (no price). */
function buildContent(title: string, condition?: string): string {
  return condition ? `${title}. ${titleCase(condition)} condition.` : title;
}

/** Most common non-empty condition among the comps (the corpus row's condition fact). */
function dominantCondition(comps: readonly EbaySoldComp[]): string | undefined {
  const counts = new Map<string, number>();
  for (const c of comps) {
    const cond = c.condition?.trim();
    if (cond) counts.set(cond, (counts.get(cond) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [cond, n] of counts) {
    if (n > bestN) {
      best = cond;
      bestN = n;
    }
  }
  return best;
}

/**
 * Cap on exemplars minted per product page — enough varied REAL titles for style
 * diversity without flooding the corpus with near-duplicates of one item.
 */
export const MAX_EXEMPLARS_PER_PRODUCT = 4;

interface RowParts {
  index: number;
  price: number;
  priceRange: { min: number; max: number };
  content: string;
  condition?: string;
  compCount: number;
}

function makeRow(query: HarvestQuery, p: RowParts): ReferenceItem {
  const baseRef = harvestSourceRef(query);
  return referenceItemSchema.parse({
    // First row keeps the base ref (stable dedupe key); extras get -1, -2, … so one
    // product page can contribute several distinct-title exemplars without colliding.
    sourceRef: p.index === 0 ? baseRef : `${baseRef}-${p.index}`,
    category: query.category,
    brand: query.brand,
    model: query.model,
    price: p.price,
    content: p.content,
    metadata: {
      source: "ebay-harvest",
      compCount: p.compCount,
      priceRange: p.priceRange,
      ...(p.condition ? { condition: p.condition } : {}),
    },
  });
}

/**
 * Mint up to MAX_EXEMPLARS_PER_PRODUCT real corpus exemplars from ONE product's
 * harvested comps — many DISTINCT real listing titles from a single (already-paid)
 * fetch, so corpus density per ScrapingBee credit is high. Returns [] when there
 * isn't enough real evidence (< HARVEST_MIN_COMPS priced comps). Pure.
 *
 * Every row shares the product identity + the robust median price (#1's outlier-
 * trimmed core); each carries a DISTINCT real title as its copy exemplar (most
 * descriptive first, case-insensitively de-duped), price kept OUT of the copy.
 */
export function exemplarsFromComps(
  comps: readonly EbaySoldComp[],
  query: HarvestQuery,
): ReferenceItem[] {
  const priced = coreComps(comps).filter((c) => c.price > 0);
  if (priced.length < HARVEST_MIN_COMPS) return [];

  const prices = priced.map((c) => c.price).sort((a, b) => a - b);
  const price = round2(median(prices));
  const priceRange = { min: prices[0], max: prices[prices.length - 1] };
  const compCount = priced.length;

  // Distinct real titles, most descriptive (longest) first; case-insensitive dedupe.
  const seen = new Set<string>();
  const picks: EbaySoldComp[] = [];
  for (const c of [...priced].sort(
    (a, b) => (b.title?.length ?? 0) - (a.title?.length ?? 0),
  )) {
    const t = c.title?.trim();
    if (!t) continue;
    const key = t.toLowerCase().replace(/\s+/g, " ");
    if (seen.has(key)) continue;
    seen.add(key);
    picks.push(c);
    if (picks.length >= MAX_EXEMPLARS_PER_PRODUCT) break;
  }

  // No titled comps → one identity-based exemplar so the product is still represented.
  if (picks.length === 0) {
    const identity =
      [query.brand, query.model].filter(Boolean).join(" ") || query.category;
    const condition = dominantCondition(priced);
    return [
      makeRow(query, {
        index: 0,
        price,
        priceRange,
        content: buildContent(identity, condition),
        condition,
        compCount,
      }),
    ];
  }

  return picks.map((c, index) => {
    const condition = c.condition?.trim() || undefined;
    return makeRow(query, {
      index,
      price,
      priceRange,
      content: buildContent(c.title!.trim(), condition),
      condition,
      compCount,
    });
  });
}

/** Single-exemplar convenience (the most descriptive title), or null. */
export function exemplarFromComps(
  comps: readonly EbaySoldComp[],
  query: HarvestQuery,
): ReferenceItem | null {
  return exemplarsFromComps(comps, query)[0] ?? null;
}

/** A seller-APPROVED SnapList listing, as the flywheel records it into the corpus. */
export interface ApprovedListing {
  /** Stable id (item/listing id) — the dedupe key, so re-approval refreshes the row. */
  id: string;
  attributes: { brand?: string; model?: string; category?: string };
  /** The approved listing copy, flattened to a string by the caller. The exemplar. */
  content: string;
  /** The accepted price (USD) — the corroboration signal. */
  price: number;
}

/**
 * Flywheel: convert a seller-APPROVED listing into a corpus exemplar. This is the
 * richest, fully-owned copy (no scraping, no copyright question) and grows the corpus
 * from real usage. Pure; the listing-approval flow calls it and upserts the result.
 * A missing category degrades to "generic" so graceful-degradation still has data.
 */
export function referenceItemFromListing(listing: ApprovedListing): ReferenceItem {
  return referenceItemSchema.parse({
    sourceRef: `flywheel-${listing.id}`,
    category: listing.attributes.category?.trim() || "generic",
    brand: listing.attributes.brand,
    model: listing.attributes.model,
    price: listing.price,
    content: listing.content,
    metadata: { source: "flywheel" },
  });
}
