"use client";

import { estimateFees, estimateNetProfit } from "@/lib/pricing/fees";

/**
 * Cost-basis field (#101) for the review Price card: "what did you pay for it".
 * Optional — blank means unknown (persists NULL, never a fake $0) — and $0 is a
 * real value (a free find). While a valid cost is present, a live estimated
 * NET line shows what the seller would actually pocket at the current price
 * (price − est. eBay fees − cost), the margin lens resellers think in.
 *
 * Controlled by the review form's field state (value/onChange come from the
 * parent so dirty-tracking and Discard work like every other field); the input
 * itself submits with the Save form via form="rv-save" / name="costBasis".
 * All math is the pure, unit-tested `fees` lib — this file is presentation.
 */

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Parse the CONTROLLED field strings for the live preview only (the server
 *  re-validates with parseCostBasis at the write boundary). */
function previewNumber(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export function CostBasisField({
  value,
  onChange,
  priceText,
  fallbackPrice,
}: {
  /** The controlled costBasis field text ("" = unknown). */
  value: string;
  onChange: (value: string) => void;
  /** The controlled price field text (the seller may be mid-edit). */
  priceText: string;
  /** The suggested price used when the price field is blank. */
  fallbackPrice: number | null;
}) {
  const cost = previewNumber(value);
  const price = previewNumber(priceText) ?? fallbackPrice;
  const net =
    price != null && cost != null && cost >= 0
      ? estimateNetProfit(price, "ebay", cost)
      : null;
  const fees = price != null ? estimateFees(price, "ebay") : null;

  return (
    <div className="mt-3">
      <span className="mb-1.5 flex items-center justify-between gap-2">
        <label
          htmlFor="review-cost-basis"
          className="text-[13px] font-medium text-fg-strong"
        >
          What you paid
        </label>
        <span className="text-[12px] text-faint">Optional</span>
      </span>
      <div className="flex items-center rounded-lg border border-border-strong bg-surface transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
        <span className="pl-3 text-[15px] text-muted">$</span>
        <input
          id="review-cost-basis"
          name="costBasis"
          form="rv-save"
          type="number"
          step="0.01"
          min="0"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0.00"
          aria-label="What you paid for this item (USD, optional)"
          className="w-full rounded-lg bg-transparent px-2 py-1.5 text-[16px] font-semibold tracking-tight text-fg-strong outline-none"
          data-nums
        />
      </div>
      {net != null ? (
        <p className="mt-1.5 text-[12.5px] text-muted" data-nums>
          Est. net profit at this price:{" "}
          <span
            className={`font-semibold ${
              net < 0 ? "text-danger-soft-fg" : "text-accent-soft-fg"
            }`}
          >
            {MONEY.format(net)}
          </span>
          {fees != null ? ` after ~${MONEY.format(fees)} eBay fees` : null}
        </p>
      ) : (
        <p className="mt-1.5 text-[12.5px] text-faint">
          Add your cost to see net profit after fees.
        </p>
      )}
    </div>
  );
}
