"use client";

/**
 * Cost-basis capture card (#101) — "what did you pay for it", asked at the
 * moment the seller still remembers. OPTIONAL and fast: defaults blank
 * (blank persists NULL — an honest unknown, never a fake $0), and "0" is a
 * real value for a free find. The uncontrolled input submits with the upload
 * form (`name="costBasis"`); `uploadAndProcess` validates it with the shared
 * `parseCostBasis` and stores it on the created item, where the review page,
 * dashboard margin column, and strategy selector pick it up.
 *
 * Chrome matches the upload page's quiet Shopify section cards.
 */
export function CostBasisCard() {
  return (
    <section className="rounded-2xl border border-border bg-surface p-4 shadow-xs sm:p-5">
      <div className="flex items-baseline justify-between gap-2">
        <label
          htmlFor="upload-cost-basis"
          className="text-[14px] font-semibold text-fg-strong"
        >
          What did you pay for it?
        </label>
        <span className="text-[12px] text-faint">Optional</span>
      </div>
      <p className="mt-1 text-[13.5px] leading-relaxed text-muted">
        Add your cost and SnapList shows net profit after fees on every price.
        Enter 0 if it was free. Leave it blank if you don’t know.
      </p>
      <div className="mt-3 flex max-w-[180px] items-center rounded-lg border border-border-strong bg-bg shadow-xs transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
        <span className="pl-3 text-[15px] text-muted">$</span>
        <input
          id="upload-cost-basis"
          name="costBasis"
          type="number"
          step="0.01"
          min="0"
          inputMode="decimal"
          placeholder="0.00"
          aria-label="What you paid for this item (USD, optional)"
          className="w-full rounded-lg bg-transparent px-2 py-2 text-[16px] font-semibold tracking-tight text-fg-strong outline-none"
          data-nums
        />
      </div>
    </section>
  );
}
