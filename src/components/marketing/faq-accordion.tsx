"use client";

/**
 * FaqAccordion (subpages v3) — accessible accordion with a smooth measured
 * height animation (grid-template-rows 0fr→1fr, see .faq-panel in
 * globals.css), chevron rotation, and a staged content fade. Replaces the
 * native <details> blocks, which snap open without transition. Reduced
 * motion drops every transition via the CSS media query.
 */

import { useId, useState } from "react";

export function FaqAccordion({
  items,
}: {
  items: ReadonlyArray<{ q: string; a: string }>;
}) {
  const [open, setOpen] = useState<number | null>(0);
  const baseId = useId();
  return (
    <div className="space-y-3">
      {items.map(({ q, a }, i) => {
        const isOpen = open === i;
        const panelId = `${baseId}-faq-${i}`;
        return (
          <div
            key={q}
            className={`rounded-2xl border bg-panel shadow-card transition-colors duration-200 ${
              isOpen ? "border-iris/40" : "border-line hover:border-line-2"
            }`}
          >
            <h3>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? null : i)}
                className="flex w-full cursor-pointer items-center justify-between gap-4 rounded-2xl px-7 py-6 text-left text-[16.5px] font-semibold text-flash"
              >
                {q}
                <svg
                  viewBox="0 0 24 24"
                  className={`size-[18px] shrink-0 transition-transform duration-300 ease-out ${
                    isOpen ? "rotate-180 text-iris" : "text-flash-faint"
                  }`}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </h3>
            <div className="faq-panel" data-open={isOpen} id={panelId}>
              <div>
                <p className="faq-panel-content px-7 pb-7 text-[15px] leading-relaxed text-flash-dim">
                  {a}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
