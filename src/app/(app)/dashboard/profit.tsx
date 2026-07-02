"use client";

import { useMemo } from "react";
import { aggregateProfit, estimateNetProfit } from "@/lib/pricing/fees";

/**
 * Dashboard profit surfaces (#101) — resellers think in margin, not list
 * price, so wherever a price appears the dashboard can also show what the
 * seller would actually pocket.
 *
 * Two small presentation components over the pure, unit-tested `fees` lib:
 *  - `RowNetProfit`: the per-listing net line under a row's price
 *    (`price − est. eBay fees − cost basis`). Renders NOTHING when the item
 *    has no recorded cost basis — price-only, never a fake $0 margin.
 *  - `ProfitSummary`: the aggregate band (total invested / projected profit
 *    across ACTIVE inventory — archived rows are excluded). Hidden entirely
 *    until at least one item carries a cost basis, so the feature is invisible
 *    until it has honest data to show.
 *
 * Kept in their own file so the (shared, wave-stacked) dashboard-view only
 * gains two additive render calls.
 */

const MONEY_WHOLE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const MONEY_CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
/** Whole dollars stay clean ($350); fractional amounts always carry BOTH cent
 *  digits ($343.70, never the lopsided $343.7 the shared min-0/max-2 pattern
 *  would print for computed fee math). */
const fmtMoney = (n: number) =>
  Number.isInteger(n) ? MONEY_WHOLE.format(n) : MONEY_CENTS.format(n);

/** The row shape the profit surfaces need (a `DashboardRow` satisfies it). */
export interface ProfitRowInput {
  price: number | null;
  costBasis: number | null;
  status: string;
}

/** Per-listing projected net under the price. Null cost basis → renders nothing. */
export function RowNetProfit({
  price,
  costBasis,
}: {
  price: number | null;
  costBasis: number | null;
}) {
  if (price == null || costBasis == null) return null;
  const net = estimateNetProfit(price, "ebay", costBasis);
  if (net == null) return null;
  return (
    <span
      className={`block text-[11.5px] font-semibold leading-tight ${
        net < 0 ? "text-danger-soft-fg" : "text-accent-soft-fg"
      }`}
      data-nums
      title="Projected net: price − cost − est. eBay fees"
    >
      {net < 0 ? "−" : "+"}
      {fmtMoney(Math.abs(net))} net
    </span>
  );
}

/**
 * Aggregate invested / projected-profit band above the listings table.
 * Archived rows are out (the issue's "active inventory"); items without a
 * cost basis never contribute (no fake zeros). Hidden when nothing is costed.
 */
export function ProfitSummary({ rows }: { rows: ProfitRowInput[] }) {
  const agg = useMemo(
    () =>
      aggregateProfit(
        rows
          .filter((r) => r.status !== "archived")
          .map((r) => ({ price: r.price, costBasis: r.costBasis })),
        "ebay",
      ),
    [rows],
  );
  if (agg.itemsWithCost === 0) return null;

  return (
    <section
      aria-label="Inventory profit summary"
      className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-border bg-surface px-4 py-3 shadow-xs sm:px-5"
    >
      <div>
        <p className="text-[12px] font-medium text-muted">Total invested</p>
        <p className="mt-0.5 text-[17px] font-bold tracking-tight text-fg-strong" data-nums>
          {fmtMoney(agg.invested)}
        </p>
      </div>
      <div>
        <p className="text-[12px] font-medium text-muted">Projected profit</p>
        <p
          className={`mt-0.5 text-[17px] font-bold tracking-tight ${
            agg.projectedProfit < 0 ? "text-danger-soft-fg" : "text-accent-soft-fg"
          }`}
          data-nums
        >
          {agg.projectedProfit < 0 ? "−" : "+"}
          {fmtMoney(Math.abs(agg.projectedProfit))}
        </p>
      </div>
      <p className="ml-auto max-w-[36ch] text-[12px] leading-relaxed text-faint" data-nums>
        After est. eBay fees, across {agg.itemsWithCost} costed item
        {agg.itemsWithCost === 1 ? "" : "s"}
        {agg.itemsProjected < agg.itemsWithCost
          ? ` (${agg.itemsWithCost - agg.itemsProjected} unpriced)`
          : ""}
        . Items without a cost show price only.
      </p>
    </section>
  );
}
