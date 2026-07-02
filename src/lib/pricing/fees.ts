/**
 * Platform fee + net-profit ESTIMATES (#101) — resellers think in margin, not
 * list price, so everywhere a price appears we can also show what the seller
 * would actually pocket: `price − platform fees − cost basis`.
 *
 * Design rules (the confidence-function pattern):
 * - PURE + deterministic: no I/O, unit-tested directly with crafted cases.
 * - One place for the fee model: a simple per-platform `rate × price + fixed`
 *   estimate, isolated in `PLATFORM_FEE_MODELS` so it's adjustable without
 *   touching call sites. These are ESTIMATES, not invoices — real fees vary by
 *   category, store level, and promos; the UI labels them "est.".
 * - HONESTY: no cost basis → `null`, never a fake $0 profit. A recorded $0
 *   cost basis (a free find) is a real zero and DOES compute. A loss goes
 *   negative rather than clamping.
 *
 * Fee references (2026 ballparks):
 * - eBay: final-value fee ≈ 13.25% for most categories + $0.30 per order.
 * - Facebook Marketplace: 5% selling fee on shipped checkout (local-pickup
 *   sales are free — the estimate assumes the paid path, the honest worst case).
 * - Mercari: ≈10% selling + ~2.9% + $0.50 payment processing → 12.9% + $0.50.
 */

export type FeePlatform = "ebay" | "facebook" | "mercari";

export interface PlatformFeeModel {
  /** Percent-of-price slice (0–1). */
  rate: number;
  /** Fixed per-order fee in dollars. */
  fixed: number;
}

export const PLATFORM_FEE_MODELS: Record<FeePlatform, PlatformFeeModel> = {
  ebay: { rate: 0.1325, fixed: 0.3 },
  facebook: { rate: 0.05, fixed: 0 },
  mercari: { rate: 0.129, fixed: 0.5 },
};

/** Round to cents. Display-precision math only — inputs are dollar amounts. */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Estimated selling fees for a price on a platform, in dollars (rounded to
 * cents). Returns null for a non-finite / non-positive price — there is no
 * honest fee estimate for a price that can't exist.
 */
export function estimateFees(price: number, platform: FeePlatform): number | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  const model = PLATFORM_FEE_MODELS[platform];
  return cents(price * model.rate + model.fixed);
}

/**
 * Estimated NET profit: `price − estimated fees − cost basis`, in dollars.
 *
 * Returns null — never a fake zero — when:
 * - the cost basis is unknown (null/undefined) or junk (non-finite/negative);
 * - the price is invalid (non-finite / non-positive).
 *
 * A $0 cost basis is a REAL zero (free find) and computes normally; a loss
 * returns a negative number.
 */
export function estimateNetProfit(
  price: number,
  platform: FeePlatform,
  costBasis: number | null | undefined,
): number | null {
  if (costBasis == null || !Number.isFinite(costBasis) || costBasis < 0) return null;
  const fees = estimateFees(price, platform);
  if (fees == null) return null;
  return cents(price - fees - costBasis);
}

export interface ProfitAggregate {
  /** Total recorded cost basis across items that have one. */
  invested: number;
  /** Sum of estimated net profit across items with BOTH a price and a cost basis. */
  projectedProfit: number;
  /** How many items carry a (valid) cost basis. */
  itemsWithCost: number;
  /** How many items contributed to `projectedProfit` (priced + costed). */
  itemsProjected: number;
}

/**
 * Aggregate invested / projected profit across an inventory slice. Items
 * without a valid cost basis are EXCLUDED (no fake zeros); items with a cost
 * but no price count toward `invested` only.
 */
export function aggregateProfit(
  rows: ReadonlyArray<{ price: number | null; costBasis: number | null }>,
  platform: FeePlatform,
): ProfitAggregate {
  let invested = 0;
  let projectedProfit = 0;
  let itemsWithCost = 0;
  let itemsProjected = 0;
  for (const row of rows) {
    const cost = row.costBasis;
    if (cost == null || !Number.isFinite(cost) || cost < 0) continue;
    itemsWithCost += 1;
    invested += cost;
    const net = row.price != null ? estimateNetProfit(row.price, platform, cost) : null;
    if (net != null) {
      itemsProjected += 1;
      projectedProfit += net;
    }
  }
  return {
    invested: cents(invested),
    projectedProfit: cents(projectedProfit),
    itemsWithCost,
    itemsProjected,
  };
}
