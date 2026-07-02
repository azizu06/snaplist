"use client";

import { useState, useTransition } from "react";
import type { RepriceSuggestionView } from "@/lib/reprice";
import type { RepriceActionResult } from "./reprice-actions";

/**
 * Dashboard reprice panel (issue #102): pending stale-inventory price
 * suggestions with their evidence (fresh comps, drift %, confidence) and
 * one-tap Apply / Dismiss, plus the per-user auto-reprice opt-in (default
 * OFF). Self-contained on purpose — the dashboard view renders it as one
 * additive slot so the UI-wave rebase stays trivial.
 */

export interface RepricePanelProps {
  suggestions: RepriceSuggestionView[];
  autoRepriceEnabled: boolean;
  applyAction: (suggestionId: string) => Promise<RepriceActionResult>;
  dismissAction: (suggestionId: string) => Promise<RepriceActionResult>;
  toggleAction: (enabled: boolean) => Promise<RepriceActionResult>;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function driftLabel(pct: number): { text: string; className: string } {
  const rounded = Math.round(Math.abs(pct));
  return pct < 0
    ? { text: `↓ ${rounded}% vs your price`, className: "text-danger" }
    : { text: `↑ ${rounded}% vs your price`, className: "text-success" };
}

export function RepricePanel({
  suggestions,
  autoRepriceEnabled,
  applyAction,
  dismissAction,
  toggleAction,
}: RepricePanelProps) {
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [autoOn, setAutoOn] = useState(autoRepriceEnabled);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const visible = suggestions.filter((s) => !resolved.has(s.id));

  const run = (id: string, action: () => Promise<RepriceActionResult>) => {
    setPendingId(id);
    startTransition(async () => {
      const result = await action();
      setMessage(result.message);
      if (result.ok) setResolved((prev) => new Set(prev).add(id));
      setPendingId(null);
    });
  };

  const toggle = () => {
    const next = !autoOn;
    setAutoOn(next); // optimistic; reverted on failure below
    startTransition(async () => {
      const result = await toggleAction(next);
      setMessage(result.message);
      if (!result.ok) setAutoOn(!next);
    });
  };

  return (
    <section
      aria-label="Price checks"
      className="rounded-2xl border border-border bg-surface p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div>
          <h2 className="text-[15px] font-bold tracking-tight text-fg-strong">
            Price checks
          </h2>
          <p className="text-[13px] text-muted">
            Stale listings are re-checked against fresh sold comps.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-fg">
          <span>Auto-reprice high-confidence</span>
          <button
            type="button"
            role="switch"
            aria-checked={autoOn}
            onClick={toggle}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              autoOn ? "bg-primary" : "bg-border-strong"
            }`}
          >
            <span
              className={`inline-block size-4 transform rounded-full bg-white shadow-xs transition-transform ${
                autoOn ? "translate-x-[18px]" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>
      </div>

      {message ? (
        <p role="status" className="mt-2 text-[13px] text-muted">
          {message}
        </p>
      ) : null}

      {visible.length === 0 ? (
        <p className="mt-3 text-[13px] text-muted">
          No repricing suggestions right now — live listings are re-checked
          automatically once they go stale.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {visible.map((s) => {
            const drift = driftLabel(s.driftPct);
            const busy = pendingId === s.id;
            return (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-border bg-surface-2 px-3.5 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold text-fg-strong">
                    {s.title}
                  </p>
                  <p className="text-[13px] text-muted">
                    {usd(s.currentPrice)} →{" "}
                    <span className="font-semibold text-fg">
                      {usd(s.targetPrice)}
                    </span>{" "}
                    <span className={drift.className}>({drift.text})</span>
                    {" · "}
                    range {usd(s.range.low)}–{usd(s.range.high)}
                    {" · "}
                    confidence {Math.round(s.confidence * 100)}%
                    {s.flooredToMinimum ? " · held at your floor" : ""}
                  </p>
                  {s.sources.length > 0 ? (
                    <p className="truncate text-[12px] text-muted">
                      {s.sources.length} fresh comp
                      {s.sources.length === 1 ? "" : "s"}:{" "}
                      {s.sources.slice(0, 3).map((src, i) => (
                        <a
                          key={src.url}
                          href={src.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline decoration-border-strong underline-offset-2 hover:text-fg"
                        >
                          {i > 0 ? ", " : ""}
                          {src.title?.slice(0, 40) || `comp ${i + 1}`}
                        </a>
                      ))}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(s.id, () => dismissAction(s.id))}
                    className="rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-[13px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2 disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => run(s.id, () => applyAction(s.id))}
                    className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover disabled:opacity-50"
                  >
                    {busy ? "Working…" : `Apply ${usd(s.targetPrice)}`}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
