/**
 * One-shot smoke test for the eBay sold-comps scraper (does ScrapingBee work?).
 *
 * SAFE BY DEFAULT: a bare run is a DRY RUN — it shows the search URL it WOULD hit,
 * confirms the required keys are present, and fetches NOTHING (0 credits). Pass
 * `--run` to do exactly ONE live fetch (~25 ScrapingBee credits) and print the
 * parsed comps, so you can confirm the scrape + parser work end-to-end without
 * spending the ~325 credits a full corpus harvest costs.
 *
 *   pnpm exec tsx scripts/scrape-smoke.ts                                # dry run, 0 credits
 *   pnpm exec tsx scripts/scrape-smoke.ts --run                          # 1 live fetch (~25 credits)
 *   pnpm exec tsx scripts/scrape-smoke.ts --run "Sony" "WH-1000XM4" "electronics"
 *
 * Env (auto-loaded from .env.local): SCRAPING_BEE_API_KEY + EBAY_SOLD_PROXY_TEMPLATE.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildSoldSearchUrl,
  createDefaultFetchPage,
  filterRelevantComps,
  parseSoldComps,
} from "../src/lib/pricing/providers/ebay-sold";
import type { ItemSignal } from "../src/lib/pricing/types";

/** Load .env.local into process.env (without overriding already-set vars). */
function loadEnvLocal(): void {
  const path = fileURLToPath(new URL("../.env.local", import.meta.url));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const key = t.slice(0, t.indexOf("=")).trim();
    const value = t.slice(t.indexOf("=") + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const CREDITS_PER_FETCH = 25;

async function main(): Promise<void> {
  loadEnvLocal();
  const args = process.argv.slice(2);
  const run = args.includes("--run");
  const positional = args.filter((a) => a !== "--run");

  const signal: ItemSignal = {
    brand: positional[0] ?? "Sony",
    model: positional[1] ?? "WH-1000XM4",
    category: positional[2] ?? "electronics",
  };

  const label = [signal.brand, signal.model].filter(Boolean).join(" ");
  const url = buildSoldSearchUrl(signal);

  console.log(`Query:        [${signal.category}] ${label}`);
  console.log(`Search URL:   ${url ?? "(could not build a URL for this signal)"}`);
  console.log(
    `Keys present: SCRAPING_BEE_API_KEY=${process.env.SCRAPING_BEE_API_KEY ? "yes" : "NO"}` +
      `  EBAY_SOLD_PROXY_TEMPLATE=${process.env.EBAY_SOLD_PROXY_TEMPLATE ? "yes" : "NO"}`,
  );

  if (!url) return;

  if (!run) {
    console.log(`\nDRY RUN — fetched nothing (0 credits). Add --run for ONE live fetch (~${CREDITS_PER_FETCH} credits).`);
    return;
  }

  if (!process.env.EBAY_SOLD_PROXY_TEMPLATE?.trim()) {
    throw new Error("EBAY_SOLD_PROXY_TEMPLATE is not set — direct eBay fetches are blocked.");
  }

  console.log(`\nFetching ONE page (~${CREDITS_PER_FETCH} credits)…`);
  const fetchPage = createDefaultFetchPage();
  const html = await fetchPage(url);
  const all = parseSoldComps(html);
  const relevant = filterRelevantComps(all, signal);

  console.log(`HTML bytes:   ${html.length}`);
  console.log(`Parsed comps: ${all.length} total → ${relevant.length} relevant after filter`);
  if (relevant.length === 0) {
    console.log("\n⚠️  0 relevant comps. Either the parser needs a selector update (eBay changed its HTML),");
    console.log("    the proxy got blocked, or this item genuinely has no recent sold listings.");
    return;
  }
  console.log("\nSample (up to 5):");
  for (const c of relevant.slice(0, 5)) {
    console.log(`  $${c.price}  ${c.condition ?? "?"}  —  ${(c.title ?? "").slice(0, 70)}`);
  }
  console.log("\n✅ ScrapingBee + the eBay sold-comps scraper work end-to-end.");
}

main().catch((err) => {
  console.error("\n❌ Scrape smoke test failed:", (err as Error).message);
  process.exit(1);
});
