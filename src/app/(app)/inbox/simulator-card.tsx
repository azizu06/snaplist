"use client";

import { StatusBadge } from "@/components/ui/badge";
import type { ItemOption } from "./inbox-client";

/**
 * Simulator card — presentational shell for the inbox's "simulate a buyer
 * question" bench (app-surfaces v3: settings-card chrome — leading icon
 * square, header row, body, sandbox footnote). Extracted from InboxClient so
 * the dev preview can render the exact same card with fixture props while
 * the live inbox wires it to Realtime state.
 */
export function SimulatorCard({
  items,
  selectedItem,
  onSelectItem,
  onSimulate,
  live,
  simulating,
}: {
  items: ItemOption[];
  selectedItem: string;
  onSelectItem: (id: string) => void;
  onSimulate: () => void;
  live: boolean;
  simulating: boolean;
}) {
  return (
    <section className="rounded-xl border border-border bg-surface shadow-xs">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <span className="flex items-center gap-2.5 text-[13px] font-semibold text-fg-strong">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-soft-fg"
          >
            {/* flask — the demo bench */}
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 2v6.3L4.6 17.4A2 2 0 0 0 6.3 20.5h11.4a2 2 0 0 0 1.7-3.1L14 8.3V2" />
              <path d="M8.5 2h7" />
              <path d="M7 15h10" />
            </svg>
          </span>
          Simulate a buyer question
        </span>
        <StatusBadge
          label={live ? "Live" : "Connecting…"}
          tone={live ? "success" : "neutral"}
        />
      </header>
      <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
        {items.length === 0 ? (
          <p className="text-sm text-muted">
            No items yet — create a listing first, then simulate a buyer
            question about it.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2.5">
            <label htmlFor="simulate-item" className="sr-only">
              Item to ask about
            </label>
            <select
              id="simulate-item"
              value={selectedItem}
              onChange={(e) => onSelectItem(e.target.value)}
              className="min-w-0 max-w-full flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-fg sm:max-w-[280px] sm:flex-none"
            >
              {items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={onSimulate}
              // Disabled until the Realtime subscription is live: simulating
              // before SUBSCRIBED could let the INSERT land before the listener
              // is active, leaving the question invisible until refresh.
              disabled={simulating || !live}
              title={live ? undefined : "Waiting for the live connection…"}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover disabled:pointer-events-none disabled:opacity-60"
            >
              {simulating
                ? "Asking…"
                : live
                  ? "Simulate buyer question"
                  : "Connecting…"}
            </button>
          </div>
        )}
        <p className="text-xs text-faint">
          Sandbox: replies are drafted by the agent, approved by you, and
          delivery is a logged no-op until the eBay adapter lands.
        </p>
      </div>
    </section>
  );
}
