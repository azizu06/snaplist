"use client";

import type { PricingStrategy } from "@/lib/pricing/strategies";
import { estimateNetProfit } from "@/lib/pricing/fees";

/**
 * Pricing-strategy selector (#94) for the review Price card. Renders the three
 * data-grounded points from `deriveStrategies` — quick / balanced / maximize —
 * as selectable cards; picking one sets the review price field (the existing save
 * flow persists it, no new server action).
 *
 * Renders NOTHING when there's only the single "Suggested" point (a tight / low-
 * confidence tier) — the gauge already carries that number, and three fabricated
 * options there would be false precision (honesty gate lives in deriveStrategies).
 *
 * Styled to match the rest of the review page: the inset surface-2 panel the
 * gauge block uses, selectable cards in the neutral+green language (accent only
 * on the chosen one), money in `data-nums`.
 */
export function PricingStrategies({
  strategies,
  selected,
  onPick,
  costBasisText,
}: {
  strategies: PricingStrategy[];
  /** The current price-field value, to mark the active card. */
  selected: string;
  onPick: (price: number) => void;
  /** The live cost-basis field value (#101); when it holds a valid cost, each
   *  card also shows projected NET profit (price − est. eBay fees − cost) so
   *  the quick/maximize tradeoff is legible in margin, not list price. */
  costBasisText?: string;
}) {
  if (strategies.length < 2) return null;
  const sel = selected.trim() !== "" ? Number(selected) : null;
  const active = sel != null ? strategies.find((s) => s.price === sel) : undefined;
  // #101: valid cost basis (0 is a real free-find zero) → per-strategy net.
  const costRaw = costBasisText?.trim() ?? "";
  const cost =
    costRaw !== "" && Number.isFinite(Number(costRaw)) && Number(costRaw) >= 0
      ? Number(costRaw)
      : null;

  return (
    <div className="mt-4 rounded-lg border border-border bg-surface-2 p-3.5">
      <p className="text-[12px] font-medium text-muted">Pricing strategy</p>
      <div className="mt-2.5 grid grid-cols-3 gap-2">
        {strategies.map((s) => {
          const on = active?.key === s.key;
          const net = cost != null ? estimateNetProfit(s.price, "ebay", cost) : null;
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={on}
              onClick={() => onPick(s.price)}
              className={`flex flex-col rounded-lg border p-2.5 text-left transition-colors ${
                on
                  ? "border-accent bg-brand-soft ring-2 ring-accent/20"
                  : "border-border bg-surface hover:border-accent/50"
              }`}
            >
              <span
                className={`text-[12px] font-medium ${
                  on ? "text-accent-soft-fg" : "text-muted"
                }`}
              >
                {s.label}
              </span>
              <span
                className="mt-0.5 text-[17px] font-bold tracking-tight text-fg-strong"
                data-nums
              >
                ${s.price}
              </span>
              {net != null ? (
                <span
                  className={`mt-0.5 text-[11.5px] font-semibold ${
                    net < 0 ? "text-danger-soft-fg" : "text-accent-soft-fg"
                  }`}
                  data-nums
                >
                  {net < 0 ? "−" : "+"}${Math.abs(net).toFixed(2)} net
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {/* The chosen strategy's honest, data-grounded one-liner (its `blurb`,
          derived in deriveStrategies) — the tradeoff behind the number, so the
          selection is explained rather than a bare price. */}
      {active ? (
        <p className="mt-2.5 text-[12.5px] leading-snug text-muted">{active.blurb}</p>
      ) : null}
    </div>
  );
}
