"use client";

import type { PricingStrategy } from "@/lib/pricing/strategies";

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
}: {
  strategies: PricingStrategy[];
  /** The current price-field value, to mark the active card. */
  selected: string;
  onPick: (price: number) => void;
}) {
  if (strategies.length < 2) return null;
  const sel = selected.trim() !== "" ? Number(selected) : null;

  return (
    <div className="mt-4 rounded-lg border border-border bg-surface-2 p-3.5">
      <p className="text-[12px] font-medium text-muted">Pricing strategy</p>
      <div className="mt-2.5 grid grid-cols-3 gap-2">
        {strategies.map((s) => {
          const active = sel != null && sel === s.price;
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={active}
              onClick={() => onPick(s.price)}
              className={`flex flex-col rounded-lg border p-2.5 text-left transition-colors ${
                active
                  ? "border-accent bg-brand-soft ring-2 ring-accent/20"
                  : "border-border bg-surface hover:border-accent/50"
              }`}
            >
              <span
                className={`text-[12px] font-medium ${
                  active ? "text-accent-soft-fg" : "text-muted"
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
            </button>
          );
        })}
      </div>
    </div>
  );
}
