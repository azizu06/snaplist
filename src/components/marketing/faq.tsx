"use client";

import { useRef, useState } from "react";
import { FAQ_ITEMS } from "@/lib/marketing/site";

/**
 * Single-open accordion.
 *
 * Two implementation notes:
 *
 * - The panel animates a measured `max-height` rather than `height: auto`.
 *   A guessed constant either clips the longest answer or leaves the shorter
 *   ones opening into dead space, and the answers here differ by several lines.
 * - Exposure is handled by `visibility` in CSS, not by an `aria-hidden` prop.
 *   `.mkt-faq__region` delays `visibility: hidden` by the collapse duration, so
 *   the content stays visible while it animates shut and leaves the
 *   accessibility tree the moment it is actually closed. Doing that in JS would
 *   need a timer that has to be cancelled on every re-toggle; the CSS version
 *   cannot drift out of sync with the animation it is waiting on.
 */
export function Faq() {
  const [open, setOpen] = useState<string | null>(null);
  const [max, setMax] = useState(0);
  const contents = useRef<Record<string, HTMLDivElement | null>>({});

  const toggle = (id: string) => {
    if (open === id) {
      setOpen(null);
      return;
    }
    setMax(contents.current[id]?.scrollHeight ?? 0);
    setOpen(id);
  };

  return (
    <div className="mkt-faq__list">
      {FAQ_ITEMS.map((item) => {
        const isOpen = open === item.id;
        return (
          <div key={item.id} className="mkt-faq__row" data-open={isOpen}>
            <button
              type="button"
              id={`mkt-faq-btn-${item.id}`}
              className="mkt-faq__btn"
              aria-expanded={isOpen}
              aria-controls={`mkt-faq-panel-${item.id}`}
              onClick={() => toggle(item.id)}
            >
              <span className="mkt-faq__q">{item.question}</span>
              <svg
                aria-hidden="true"
                className="mkt-faq__chevron"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <div
              id={`mkt-faq-panel-${item.id}`}
              role="region"
              aria-labelledby={`mkt-faq-btn-${item.id}`}
              className="mkt-faq__region"
              data-open={isOpen}
              style={isOpen ? ({ ["--faq-max" as string]: `${max}px` }) : undefined}
            >
              <div className="mkt-faq__clip">
                <div
                  ref={(node) => {
                    contents.current[item.id] = node;
                  }}
                  className="mkt-faq__content"
                >
                  <p className="mkt-faq__a">{item.answer}</p>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
