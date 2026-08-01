import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural guard for issue #591: no deployed code path may change the price
 * of a LIVE eBay listing without a seller confirming it.
 *
 * AGENTS.md ("launch has no autonomous marketplace actions") and ADR-0008 both
 * retired reprice. The stale-inventory sweep (#102) was the last place the code
 * still disagreed: a deployed `/api/cron/reprice` route reached
 * `adapter.revisePrice` behind nothing but knowledge of `CRON_SECRET`, so
 * setting that secret for the pipeline worker would have armed autonomous
 * repricing as a side effect of unrelated work.
 *
 * Removal alone does not stay removed — the seam here is the eBay adapter
 * boundary, so these assertions fence it. `revisePrice` stays on the adapter
 * (a seller-confirmed price revision is a legitimate future feature); what may
 * never come back is a *caller* outside the adapter's own directory.
 *
 * Both assertions carry a positive control. A tree walk that is misrooted or
 * over-pruned finds nothing and reports success just as confidently as a clean
 * tree does, so each test also proves it can still see something it expects.
 */

const SRC = join(process.cwd(), "src");

/** Only the adapter interface, its HTTP implementation, the mock, and their tests. */
const ADAPTER_DIR = join("src", "lib", "marketplace", "ebay");

/** Repo-relative paths of every file under `src/` whose text contains `needle`. */
function sourceFilesContaining(needle: string): string[] {
  const hits: string[] = [];

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      if (readFileSync(full, "utf8").includes(needle)) {
        hits.push(full.slice(process.cwd().length + 1));
      }
    }
  }

  walk(SRC);
  return hits.sort();
}

describe("no autonomous eBay price mutation (#591)", () => {
  it("has no revisePrice caller outside the eBay adapter directory", () => {
    const callers = sourceFilesContaining("revisePrice");

    // Positive control: if the walk were misrooted or the extension filter too
    // narrow, `callers` would be empty and the real assertion would pass
    // vacuously. The adapter itself must always be in the result.
    expect(callers).toContain(join(ADAPTER_DIR, "types.ts"));

    const outside = callers.filter((path) => !path.startsWith(ADAPTER_DIR));
    expect(outside).toEqual([]);
  });

  it("does not deploy a repricing cron route", () => {
    const cronDir = join(process.cwd(), "src", "app", "api", "cron");

    // Positive control: prove we are looking at the real cron directory. If
    // this path were wrong, the absence check below would pass for free.
    expect(existsSync(join(cronDir, "inbox-sync", "route.ts"))).toBe(true);

    // No route file at the path is exactly what makes `/api/cron/reprice`
    // return 404 in the App Router.
    expect(existsSync(join(cronDir, "reprice"))).toBe(false);
  });
});
