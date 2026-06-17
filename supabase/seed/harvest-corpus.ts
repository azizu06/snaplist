/**
 * Harvest REAL reference-corpus exemplars from eBay's public sold pages — the
 * cold-start half of the "harvest + flywheel" corpus strategy (the flywheel half is
 * `referenceItemFromListing`, called from the listing-approval flow).
 *
 * For each hero-weighted seed PRODUCT it: builds the sold-search URL, fetches via the
 * SAME scraper the pricing tier uses (premium proxy), parses + relevance-filters the
 * comps, and mints ONE real corpus row (`exemplarFromComps`: robust median price +
 * a real title exemplar). Then it embeds + UPSERTs via the existing seed path.
 *
 * SAFE BY DEFAULT: a bare run is a DRY RUN — it prints the plan + a ScrapingBee credit
 * estimate and fetches NOTHING. Pass `--run` to actually fetch + seed.
 *
 *   pnpm exec tsx supabase/seed/harvest-corpus.ts            # dry run (no credits)
 *   pnpm exec tsx supabase/seed/harvest-corpus.ts --run      # fetch + embed + upsert
 *
 * Env (from `.env.local`, auto-loaded below): EBAY_SOLD_PROXY_TEMPLATE (premium proxy),
 * SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, and OPENAI_API_KEY for real embeddings.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import {
  buildSoldSearchUrl,
  createDefaultFetchPage,
  filterRelevantComps,
  parseSoldComps,
} from "../../src/lib/pricing/providers/ebay-sold";
import type { ItemSignal } from "../../src/lib/pricing/types";
import {
  MAX_EXEMPLARS_PER_PRODUCT,
  exemplarsFromComps,
  type HarvestQuery,
} from "../../src/lib/rag/harvest";
import { selectEmbedder } from "../../src/lib/rag/embedding";
import { seedReferenceCorpus } from "./reference-corpus";

/** Load `.env.local` into process.env (without overriding already-set vars). */
function loadEnvLocal(): void {
  const path = fileURLToPath(new URL("../../.env.local", import.meta.url));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // no .env.local — rely on the ambient environment
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const key = t.slice(0, t.indexOf("=")).trim();
    const value = t.slice(t.indexOf("=") + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Hero-weighted seed products (real identities; the prices/titles come from the live
 * harvest, never invented). Books are better served by the ISBN tier, so they're light
 * here; electronics/board-games/branded-gear carry the weight, mirroring the hero domain.
 */
const SEED_QUERIES: HarvestQuery[] = [
  // Electronics (hero)
  { category: "electronics", brand: "Sony", model: "WH-1000XM4" },
  { category: "electronics", brand: "Apple", model: "AirPods Pro 2nd Generation" },
  { category: "electronics", brand: "Nintendo", model: "Switch OLED" },
  { category: "electronics", brand: "Logitech", model: "MX Master 3S" },
  { category: "electronics", brand: "Amazon", model: "Kindle Paperwhite 11th Gen" },
  // Board games (hero)
  { category: "board-games", brand: "Catan Studio", model: "Catan" },
  { category: "board-games", brand: "Days of Wonder", model: "Ticket to Ride" },
  { category: "board-games", brand: "Stonemaier Games", model: "Wingspan" },
  // Branded gear (hero)
  { category: "branded-gear", brand: "Stanley", model: "Quencher H2.0 40oz" },
  { category: "branded-gear", brand: "YETI", model: "Rambler 20oz" },
  { category: "branded-gear", brand: "Patagonia", model: "Better Sweater" },
  // Books (light — the ISBN tier is the real path here)
  { category: "books", brand: "Andrew Hunt", model: "The Pragmatic Programmer" },
  { category: "books", brand: "Robert Martin", model: "Clean Code" },
];

/** ~credits per premium-proxy fetch (eBay/Akamai → residential proxy). Rough, for the estimate. */
const CREDITS_PER_FETCH = 25;

function toSignal(q: HarvestQuery): ItemSignal {
  return { brand: q.brand, model: q.model, category: q.category };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const run = process.argv.includes("--run");

  console.log(`Harvest plan: ${SEED_QUERIES.length} products across hero categories`);
  for (const q of SEED_QUERIES) {
    console.log(`  • [${q.category}] ${[q.brand, q.model].filter(Boolean).join(" ")}`);
  }
  const estCredits = SEED_QUERIES.length * CREDITS_PER_FETCH;
  console.log(
    `\nEstimated ScrapingBee cost: ~${estCredits} credits (~${CREDITS_PER_FETCH}/fetch, ` +
      `1 fetch/product). Each page yields up to ${MAX_EXEMPLARS_PER_PRODUCT} real ` +
      `exemplars → up to ~${SEED_QUERIES.length * MAX_EXEMPLARS_PER_PRODUCT} corpus rows.`,
  );

  if (!run) {
    console.log("\nDRY RUN — nothing fetched. Re-run with --run to fetch + seed.");
    return;
  }

  if (!process.env.EBAY_SOLD_PROXY_TEMPLATE?.trim()) {
    throw new Error(
      "EBAY_SOLD_PROXY_TEMPLATE is not set — direct eBay fetches are blocked. " +
        "Set the premium-proxy template in .env.local before --run.",
    );
  }
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error(
      "Seeding requires SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and " +
        "SUPABASE_SERVICE_ROLE_KEY (from `pnpm supabase status -o env`).",
    );
  }

  const fetchPage = createDefaultFetchPage();
  const items = [];
  for (const q of SEED_QUERIES) {
    const signal = toSignal(q);
    const searchUrl = buildSoldSearchUrl(signal);
    const label = `[${q.category}] ${[q.brand, q.model].filter(Boolean).join(" ")}`;
    if (!searchUrl) {
      console.warn(`  ✗ ${label}: could not build a search URL (skipped)`);
      continue;
    }
    try {
      const html = await fetchPage(searchUrl);
      const relevant = filterRelevantComps(parseSoldComps(html), signal);
      const exemplars = exemplarsFromComps(relevant, q);
      if (exemplars.length > 0) {
        items.push(...exemplars);
        console.log(
          `  ✓ ${label}: ${exemplars.length} exemplars @ $${exemplars[0].price} ` +
            `from ${exemplars[0].metadata.compCount} comps`,
        );
      } else {
        console.warn(`  ∅ ${label}: too few relevant comps (skipped)`);
      }
    } catch (err) {
      console.warn(`  ✗ ${label}: fetch/parse failed — ${(err as Error).message}`);
    }
  }

  if (items.length === 0) {
    console.log("\nNo exemplars harvested — nothing to seed.");
    return;
  }

  const embedder = selectEmbedder({ OPENAI_API_KEY: process.env.OPENAI_API_KEY });
  console.log(
    `\nEmbedding ${items.length} harvested rows with ${embedder.kind} (${embedder.model})…`,
  );
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const rows = await seedReferenceCorpus(admin, embedder, items);
  console.log(`✓ Upserted ${rows.length} REAL harvested reference rows into reference_corpus.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
