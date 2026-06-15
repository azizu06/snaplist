/**
 * Gold-set auto-builder (issue #61). A ONE-OFF script that (re)builds the eval gold
 * set's ground-truth PRICE BANDS from a live eBay public sold-comp scrape, over a
 * curated set of hero-item identities. The price truth therefore comes from a
 * SOURCE (real completed sales), NOT from running our own pricing pipeline — so the
 * eval never grades the pipeline against itself.
 *
 * Split for testability (mirrors run.ts):
 *  - the band-derivation + assembly logic is PURE and unit-tested offline;
 *  - the network sources are an INJECTED seam (`GoldSetSources`); the CLI `main`
 *    wires the real eBay-sold scraper.
 *
 * It writes to `--out` (default: stdout), never silently clobbering the curated
 * `fixtures/gold-set.json` — the output is a candidate for a ~10-minute human
 * spot-check before it replaces the committed set.
 */

import { writeFile } from "node:fs/promises";
import {
  buildSoldSearchUrl,
  createDefaultFetchPage,
  parseSoldComps,
} from "../pricing/providers/ebay-sold";
import { GOLD_SET } from "./fixtures";
import { goldItemSchema, type GoldItem, type GoldTruth } from "./types";

/**
 * A curated seed: WHICH hero item to include, with its verified identity. The
 * price band is DERIVED from live sold data — not authored here — so refreshing
 * the set is a re-scrape, not hand-editing numbers.
 */
export interface GoldSeed {
  id: string;
  sourceRef?: string;
  truth: GoldTruth;
  notes?: string;
}

/**
 * Injected data sources (real CLI wires the eBay-sold scraper). Kept minimal so
 * the builder is fully unit-testable offline with fakes.
 */
export interface GoldSetSources {
  /** Live SOLD prices for the seed's item (e.g. eBay sold comps). `[]` = none. */
  soldPrices(seed: GoldSeed): Promise<number[]>;
}

/** Need at least this many sold comps for a defensible band (else skip the item). */
export const GOLD_MIN_PRICES = 3;

/**
 * A defensible used-price band from sold prices. With ≥5 points we trim the single
 * lowest and highest (a lone fluke/typo sale shouldn't define the band); otherwise
 * the observed min..max. Pure and total — returns null when there's too little
 * data to be defensible, so the caller skips (and reports) the item rather than
 * fabricating a band.
 */
export function priceBandFromSoldPrices(
  prices: readonly number[],
): { low: number; high: number } | null {
  const xs = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (xs.length < GOLD_MIN_PRICES) return null;
  const lo = xs.length >= 5 ? xs[1] : xs[0];
  const hi = xs.length >= 5 ? xs[xs.length - 2] : xs[xs.length - 1];
  const low = Math.floor(lo);
  const high = Math.max(low + 1, Math.ceil(hi)); // guarantee low < high
  return { low, high };
}

export interface BuildGoldItemResult {
  item?: GoldItem;
  /** Why this seed was skipped (surfaced for the human spot-check). */
  skipped?: string;
}

/** Build ONE gold item: derive its band from live sold prices, then validate. */
export async function buildGoldItem(
  seed: GoldSeed,
  sources: GoldSetSources,
): Promise<BuildGoldItemResult> {
  const prices = await sources.soldPrices(seed);
  const band = priceBandFromSoldPrices(prices);
  if (!band) {
    return { skipped: `${seed.id}: only ${prices.length} sold price(s) (<${GOLD_MIN_PRICES})` };
  }
  const item = goldItemSchema.parse({
    id: seed.id,
    ...(seed.sourceRef ? { sourceRef: seed.sourceRef } : {}),
    truth: seed.truth,
    priceBand: band,
    ...(seed.notes ? { notes: seed.notes } : {}),
  });
  return { item };
}

export interface BuildGoldSetResult {
  items: GoldItem[];
  /** Seeds that produced no item (duplicate id or too little sold data). */
  skipped: string[];
}

/**
 * Build the gold set from seeds, deriving each band from live sold data. Dedups by
 * id, sorts by id for a stable diff, and RETURNS the skipped seeds — silent
 * truncation would read as "covered everything" when it didn't (a no-silent-caps
 * discipline). The caller reviews `skipped` before trusting the output.
 */
export async function buildGoldSet(
  seeds: readonly GoldSeed[],
  sources: GoldSetSources,
): Promise<BuildGoldSetResult> {
  const items: GoldItem[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    if (seen.has(seed.id)) {
      skipped.push(`${seed.id}: duplicate id`);
      continue;
    }
    seen.add(seed.id);
    const { item, skipped: why } = await buildGoldItem(seed, sources);
    if (item) items.push(item);
    else if (why) skipped.push(why);
  }
  items.sort((a, b) => a.id.localeCompare(b.id));
  return { items, skipped };
}

/**
 * Seeds for the builder: the curated identities from the CURRENT gold set (each
 * item's verified truth + sourceRef), so a refresh re-derives the bands from
 * today's market instead of hand-editing numbers. Extend with demo-set / ISBN
 * items here to grow coverage.
 */
export function seedsFromGoldSet(gold: readonly GoldItem[] = GOLD_SET): GoldSeed[] {
  return gold.map((g) => ({
    id: g.id,
    ...(g.sourceRef ? { sourceRef: g.sourceRef } : {}),
    truth: g.truth,
    ...(g.notes ? { notes: g.notes } : {}),
  }));
}

// ---------------------------------------------------------------------------
// CLI — wires the REAL eBay-sold scrape. Network + fs; guarded entrypoint.
// ---------------------------------------------------------------------------

/** Real source: one-off eBay public sold-comp scrape → the raw sold prices. */
function liveEbaySoldSources(): GoldSetSources {
  const baseUrl = process.env.EBAY_SOLD_BASE_URL?.trim() || "https://www.ebay.com";
  const fetchPage = createDefaultFetchPage();
  return {
    async soldPrices(seed) {
      const url = buildSoldSearchUrl(
        {
          brand: seed.truth.brand,
          model: seed.truth.model,
          isbn: seed.truth.isbn,
          category: seed.truth.category,
        },
        baseUrl,
      );
      if (!url) return [];
      try {
        const html = await fetchPage(url);
        return parseSoldComps(html, baseUrl).map((c) => c.price);
      } catch {
        return []; // a block/timeout → no data → the item is skipped + reported
      }
    },
  };
}

export async function main(argv: readonly string[]): Promise<void> {
  const outIdx = argv.indexOf("--out");
  const outPath = outIdx >= 0 ? argv[outIdx + 1] : undefined;

  const { items, skipped } = await buildGoldSet(seedsFromGoldSet(), liveEbaySoldSources());

  const json = JSON.stringify(items, null, 2);
  if (outPath) {
    await writeFile(outPath, json + "\n", "utf8");
    console.error(`Wrote ${items.length} gold items → ${outPath}`);
  } else {
    console.log(json);
  }
  // Always report what was dropped so the human spot-check is honest.
  console.error(
    `Built ${items.length} item(s); skipped ${skipped.length}.` +
      (skipped.length ? `\n  - ${skipped.join("\n  - ")}` : ""),
  );
}

const invokedDirectly =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  /build-gold-set\.(ts|js)$/.test(process.argv[1].split("/").pop() ?? "<never>");

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
