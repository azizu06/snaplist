"use client";

import Link from "next/link";
import { useState } from "react";
import { StatusBadge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { lifecycleLabel, lifecycleShortLabel } from "@/lib/ui/status";
import { matchesQuery } from "@/lib/ui/search";
import { relativeDay } from "@/lib/ui/dates";

/**
 * Dashboard — Shopify products index, replicated (issue #40 round 2; Mobbin
 * Shopify admin reference), upgraded interactive in dashboard v2: page header
 * with the count, the stat-tab filter cards, then ONE card holding a toolbar
 * (live inline search using the same tested matcher as ⌘K) and a real data
 * table (thumbnail · title · status pill · price · created · hover chevron).
 * Rows stagger-fade in. Mobile collapses the table to Depop-style rows.
 *
 * Client component, but still pure presentation over serializable props: the
 * page assembles rows; the preview harness feeds fixtures.
 */

export interface DashboardRow {
  itemId: string;
  listingId: string | null;
  title: string;
  status: string;
  createdAt: string;
  price: number | null;
  thumbUrl: string | null;
}

export interface DashboardCounts {
  draft: number;
  attention: number;
  live: number;
}

export const DASHBOARD_FILTERS: ReadonlyArray<{
  key: "all" | "draft" | "queued" | "live" | "attention";
  label: string;
  statuses: readonly string[] | null;
}> = [
  { key: "all", label: "All", statuses: null },
  { key: "draft", label: "Draft", statuses: ["draft"] },
  { key: "queued", label: "Queued", statuses: ["queued"] },
  { key: "live", label: "Live", statuses: ["published"] },
  { key: "attention", label: "Needs attention", statuses: ["failed", "draft_failed"] },
];

const PRICE_FMT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function Thumb({ url }: { url: string | null }) {
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL
    <img
      src={url}
      alt=""
      aria-hidden
      className="size-10 shrink-0 rounded-lg border border-border object-cover"
    />
  ) : (
    <span
      aria-hidden
      className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-faint"
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
      </svg>
    </span>
  );
}

// `counts` stays in the props API for the page/preview callers, but the
// stat-tab cards compute per-filter counts from `rows` directly.
export function DashboardView({
  rows,
  filter,
}: {
  rows: DashboardRow[];
  counts: DashboardCounts;
  filter: (typeof DASHBOARD_FILTERS)[number]["key"];
}) {
  const [query, setQuery] = useState("");

  const activeFilter =
    DASHBOARD_FILTERS.find((f) => f.key === filter) ?? DASHBOARD_FILTERS[0];
  const statusFiltered = activeFilter.statuses
    ? rows.filter((r) => activeFilter.statuses!.includes(r.status))
    : rows;
  const visible = statusFiltered.filter((r) => matchesQuery(r.title, query));
  const searching = query.trim() !== "";

  const filterCount = (f: (typeof DASHBOARD_FILTERS)[number]) =>
    f.statuses ? rows.filter((r) => f.statuses!.includes(r.status)).length : rows.length;

  // Cap the stagger so long tables don't crawl in.
  const enterDelay = (i: number) => `${Math.min(i, 10) * 30}ms`;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-7 sm:px-6">
      {/* ---- page header (Stripe: 24px bold title; primary lives in topbar) ---- */}
      <header className="flex items-center justify-between gap-3">
        <h1 className="font-display text-[24px] font-bold tracking-tight text-fg-strong">
          Listings
        </h1>
        <span className="text-[12.5px] text-muted" data-nums>
          {rows.length} item{rows.length === 1 ? "" : "s"}
        </span>
      </header>

      {rows.length === 0 ? (
        <EmptyState
          title="List your first item"
          detail="Take a photo of something you want to sell — we'll identify it, research the price, and write the listing for you."
          action={
            <Link
              href="/upload"
              className="inline-flex items-center rounded-lg bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover"
            >
              New listing
            </Link>
          }
        />
      ) : (
        <>
          {/* ---- stat-tab cards (Stripe Transactions pattern: the filters ARE
               the metric cards; selected = violet border) ---- */}
          <nav
            aria-label="Filter by status"
            className="-mx-4 flex gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:grid sm:grid-cols-5 sm:overflow-visible sm:px-0 sm:pb-0"
          >
            {DASHBOARD_FILTERS.map((f) => {
              const active = f.key === filter;
              return (
                <Link
                  key={f.key}
                  href={f.key === "all" ? "/dashboard" : `/dashboard?filter=${f.key}`}
                  aria-current={active ? "page" : undefined}
                  className={`min-w-[124px] shrink-0 rounded-xl border bg-surface px-3.5 py-2.5 transition-all motion-safe:active:scale-[0.98] sm:min-w-0 ${
                    active
                      ? "border-accent shadow-[0_0_0_1px_var(--color-accent)]"
                      : "border-border hover:-translate-y-px hover:border-border-strong hover:shadow-xs"
                  }`}
                >
                  <span
                    className={`block text-[12px] font-medium ${
                      active ? "text-accent-soft-fg" : "text-muted"
                    }`}
                  >
                    {f.label}
                  </span>
                  <span className="mt-0.5 block text-[18px] font-bold text-fg-strong" data-nums>
                    {filterCount(f)}
                  </span>
                </Link>
              );
            })}
          </nav>

          {/* ---- table card ---- */}
          <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
            {/* toolbar: inline search over the active tab */}
            <div className="flex items-center gap-3 border-b border-border px-3 py-2.5">
              <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[13px] focus-within:ring-2 focus-within:ring-accent/40 sm:max-w-xs">
                <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={`Filter ${activeFilter.key === "all" ? "listings" : `“${activeFilter.label}”`}…`}
                  aria-label="Filter listings by title"
                  className="w-full bg-transparent text-fg-strong outline-none placeholder:text-faint"
                />
                {searching ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear filter"
                    className="shrink-0 rounded text-faint transition-colors hover:text-fg"
                  >
                    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                ) : null}
              </label>
              {searching ? (
                <span className="shrink-0 text-[12px] text-muted" data-nums>
                  {visible.length} match{visible.length === 1 ? "" : "es"}
                </span>
              ) : null}
            </div>

            {visible.length === 0 ? (
              searching ? (
                <p className="px-4 py-10 text-center text-sm text-muted">
                  No titles match “{query.trim()}”.{" "}
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="font-semibold text-accent-soft-fg hover:underline"
                  >
                    Clear
                  </button>
                </p>
              ) : (
                <p className="px-4 py-10 text-center text-sm text-muted">
                  Nothing under “{activeFilter.label}” — items move here as their
                  status changes.
                </p>
              )
            ) : (
              <>
                {/* desktop: Shopify data table */}
                <table className="hidden w-full sm:table">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
                      <th className="py-2.5 pl-4 pr-2 font-semibold">Product</th>
                      <th className="px-2 py-2.5 font-semibold">Status</th>
                      <th className="px-2 py-2.5 text-right font-semibold">Price</th>
                      <th className="py-2.5 pl-2 font-semibold text-right">Created</th>
                      <th className="w-10" aria-hidden />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {visible.map((row, i) => {
                      const chip = lifecycleLabel(row.status);
                      return (
                        <tr
                          key={`${row.itemId}-${row.listingId ?? "item"}`}
                          className="group row-enter transition-colors hover:bg-surface-2/50"
                          style={{ animationDelay: enterDelay(i) }}
                        >
                          <td className="py-2 pl-4 pr-2">
                            <Link
                              href={`/review/${row.itemId}`}
                              className="flex items-center gap-3"
                            >
                              <Thumb url={row.thumbUrl} />
                              <span className="truncate text-[13px] font-semibold text-fg-strong group-hover:underline">
                                {row.title}
                              </span>
                            </Link>
                          </td>
                          <td className="px-2 py-2">
                            {chip ? (
                              <StatusBadge label={chip.label} tone={chip.tone} dot={false} />
                            ) : null}
                          </td>
                          <td className="px-2 py-2 text-right text-[13px] text-fg" data-nums>
                            {row.price != null ? PRICE_FMT.format(row.price) : "—"}
                          </td>
                          <td className="py-2 pl-2 text-right text-[13px] text-muted" data-nums>
                            {row.createdAt ? relativeDay(row.createdAt) : "—"}
                          </td>
                          <td className="py-2 pl-1 pr-3">
                            <svg
                              viewBox="0 0 24 24"
                              aria-hidden
                              className="size-4 text-faint opacity-0 transition-[opacity,transform] duration-150 group-hover:translate-x-0.5 group-hover:opacity-100"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="m9 18 6-6-6-6" />
                            </svg>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                {/* mobile: Depop-style rows */}
                <ul className="divide-y divide-border sm:hidden">
                  {visible.map((row, i) => {
                    const chip = lifecycleShortLabel(row.status);
                    return (
                      <li
                        key={`m-${row.itemId}-${row.listingId ?? "item"}`}
                        className="row-enter"
                        style={{ animationDelay: enterDelay(i) }}
                      >
                        <Link
                          href={`/review/${row.itemId}`}
                          className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50 active:bg-surface-2"
                        >
                          <Thumb url={row.thumbUrl} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-fg-strong">
                              {row.title}
                            </span>
                            <span className="mt-0.5 block text-xs text-muted" data-nums>
                              {row.price != null ? PRICE_FMT.format(row.price) : "No price yet"}
                              {row.createdAt ? ` · ${relativeDay(row.createdAt)}` : ""}
                            </span>
                          </span>
                          {chip ? (
                            <StatusBadge label={chip.label} tone={chip.tone} dot={false} />
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}
