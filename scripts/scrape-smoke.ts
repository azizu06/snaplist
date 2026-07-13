/**
 * Operator-controlled smoke for the existing in-process eBay sold-comps seam.
 *
 * Safe default: zero network requests. A live run requires BOTH explicit flags
 * and performs at most one sold-page request; it never invokes web-search or an
 * LLM fallback. Output is structured and excludes proxy templates/credentials.
 *
 *   pnpm smoke:sold-comps
 *   pnpm smoke:sold-comps -- --live --confirm-one-request
 *   pnpm smoke:sold-comps -- --live --confirm-one-request Sony WH-1000XM4 electronics
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSoldCompsSmoke } from "../src/lib/pricing/sold-comps-smoke";
import type { ItemSignal } from "../src/lib/pricing/types";

/** Load .env.local without overriding variables already supplied by the operator. */
function loadEnvLocal(): void {
  const path = fileURLToPath(new URL("../.env.local", import.meta.url));
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const args = process.argv.slice(2);
  const liveRequested = args.includes("--live");
  const liveConfirmed = args.includes("--confirm-one-request");
  const positional = args.filter(
    (arg) =>
      arg !== "--" && arg !== "--live" && arg !== "--confirm-one-request",
  );

  if (liveRequested !== liveConfirmed) {
    throw new Error(
      "Live smoke requires both --live and --confirm-one-request; no request was made.",
    );
  }

  const signal: ItemSignal = {
    brand: positional[0] ?? "Sony",
    model: positional[1] ?? "WH-1000XM4",
    category: positional[2] ?? "electronics",
    condition: "good",
    conditionKnown: true,
  };
  const report = await runSoldCompsSmoke({
    mode: liveRequested ? "live" : "dry-run",
    signal,
  });

  console.log(JSON.stringify(report, null, 2));
  if (liveRequested && report.status !== "success") process.exitCode = 2;
}

main().catch((error) => {
  const message =
    error instanceof Error && error.message.startsWith("Invalid EBAY_SOLD_PROXY_TEMPLATE")
      ? error.message
      : error instanceof Error && error.message.includes("no request was made")
        ? error.message
        : "Sold-comps smoke configuration failed; no request was made.";
  console.error(message);
  process.exitCode = 1;
});
