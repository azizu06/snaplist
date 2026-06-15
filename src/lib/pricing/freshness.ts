/**
 * Pricing freshness (issue #59): pure recency/age-decay helpers for sold comps.
 *
 * Sold prices drift, so a completed sale's INFLUENCE on the suggested price should
 * fade with age, and sales older than a cutoff should be ignored entirely. These
 * functions are pure and take `now` explicitly (no `Date.now()` inside) so they are
 * deterministic and unit-testable — the impure clock read lives at the provider
 * boundary (mirrors `computeConfidence` / `parseEnv`). The TTL request *cache*
 * (which cuts scrape footprint) is a separate concern — see `comp-cache.ts`.
 */

const DAY_MS = 86_400_000;

/**
 * Default staleness cutoff (days): a sold comp with a KNOWN sale date older than
 * this is dropped — a year-old sale is weak evidence of today's used price.
 */
export const SOLD_STALE_DAYS_DEFAULT = 180;

/**
 * Default recency half-life (days): a sale this many days old counts HALF as much
 * as a sale today in the weighted suggested price. Shorter than the stale cutoff,
 * so influence fades smoothly well before a comp is dropped outright.
 */
export const SOLD_HALFLIFE_DAYS_DEFAULT = 45;

/** Age of a sale in days relative to `now` (negative if future-dated). */
export function ageDays(soldAt: number, now: number): number {
  return (now - soldAt) / DAY_MS;
}

/**
 * Exponential recency weight in (0, 1]. A sale today weighs 1; one half-life ago,
 * 0.5; older, less. An UNKNOWN sale date weighs 1 (neutral) — we never penalize a
 * comp for missing date metadata, only for being demonstrably old. Future-dated
 * sales (clock skew) clamp to 1.
 */
export function recencyWeight(
  soldAt: number | undefined,
  now: number,
  halfLifeDays: number = SOLD_HALFLIFE_DAYS_DEFAULT,
): number {
  if (soldAt == null) return 1;
  if (!(halfLifeDays > 0)) return 1;
  const days = ageDays(soldAt, now);
  if (!(days > 0)) return 1; // sold today or (skew) in the future
  return Math.pow(0.5, days / halfLifeDays);
}

/**
 * Is a comp stale? True ONLY when its sale date is known AND older than the cutoff.
 * An undated comp is never stale (we can't expire what we can't date — precision
 * over recall on exclusion, matching the scraper's relevance philosophy).
 */
export function isStaleComp(
  soldAt: number | undefined,
  now: number,
  staleDays: number = SOLD_STALE_DAYS_DEFAULT,
): boolean {
  if (soldAt == null) return false;
  return ageDays(soldAt, now) > staleDays;
}

/** Drop the known-stale comps, preserving order; keep fresh and undated ones. */
export function selectFreshComps<T extends { soldAt?: number }>(
  comps: readonly T[],
  now: number,
  staleDays: number = SOLD_STALE_DAYS_DEFAULT,
): T[] {
  return comps.filter((c) => !isStaleComp(c.soldAt, now, staleDays));
}

const plainMedian = (sorted: readonly number[]): number => {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Weighted median: the value at which the cumulative weight first reaches half the
 * total. Robust to outliers (a single very-recent extreme sale shifts but does not
 * dominate, unlike a weighted mean). Reduces EXACTLY to the plain median when all
 * weights are equal — including the even-count "average of the two middles" case —
 * so introducing recency weighting is a no-op when every comp weighs the same
 * (e.g. all undated). Falls back to the plain median if total weight is zero.
 */
export function weightedMedian(
  values: readonly number[],
  weights: readonly number[],
): number {
  if (values.length === 0) throw new Error("weightedMedian requires ≥1 value");
  if (values.length === 1) return values[0];

  const pairs = values
    .map((v, i) => ({ v, w: weights[i] ?? 0 }))
    .sort((a, b) => a.v - b.v);
  const total = pairs.reduce((s, p) => s + p.w, 0);
  if (!(total > 0)) {
    return plainMedian(values.slice().sort((a, b) => a - b));
  }

  const half = total / 2;
  let cum = 0;
  for (let i = 0; i < pairs.length; i++) {
    cum += pairs[i].w;
    if (cum > half) return pairs[i].v;
    if (cum === half) {
      // Mass splits exactly at this value — average with the next distinct value,
      // mirroring the plain median's even-count behavior.
      return i + 1 < pairs.length ? (pairs[i].v + pairs[i + 1].v) / 2 : pairs[i].v;
    }
  }
  return pairs[pairs.length - 1].v;
}
