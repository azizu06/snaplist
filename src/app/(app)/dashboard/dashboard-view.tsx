"use client";

import Link from "next/link";
import { useState } from "react";
import CountUp from "@/components/bits/CountUp";
import { DEMO_PRODUCTS_BY_SLUG, type DemoProduct } from "@/lib/demo-products";
import { StatusBadge } from "@/components/ui/badge";
import { lifecycleLabel, lifecycleShortLabel } from "@/lib/ui/status";
import { matchesQuery } from "@/lib/ui/search";
import { relativeDay } from "@/lib/ui/dates";
import { DASHBOARD_FILTERS, type DashboardFilterKey } from "./filters";

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
      className="size-11 shrink-0 rounded-lg border border-border object-cover"
    />
  ) : (
    <span
      aria-hidden
      className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2 text-faint"
    >
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
      </svg>
    </span>
  );
}

/**
 * Empty dashboard (home pass r2) — a calm, minimal first-run hero in the review
 * page's card language (rounded-2xl, plain border): a static trio of EXAMPLE
 * listing previews ("this is what your listings become"), a headline, and the
 * New listing CTA. Replaces the animated folder, which read as a flat purple box
 * until interacted with. Image + name + price always come from the SAME
 * DemoProduct, so a preview can never carry another item's label.
 */
const EXAMPLE_PRODUCTS: DemoProduct[] = [
  DEMO_PRODUCTS_BY_SLUG.kettlebell,
  DEMO_PRODUCTS_BY_SLUG.binoculars,
  DEMO_PRODUCTS_BY_SLUG.sewingmachine,
];

function EmptyPreviewCard({ product }: { product: DemoProduct }) {
  return (
    <div className="w-24 shrink-0 overflow-hidden rounded-xl border border-border bg-surface shadow-xs sm:w-32">
      {/* eslint-disable-next-line @next/next/no-img-element -- static demo thumbnail */}
      <img
        src={product.image}
        alt=""
        aria-hidden
        className="h-20 w-full object-cover sm:h-24"
      />
      <div className="px-2.5 py-2 text-left">
        <p className="truncate text-[12px] font-semibold text-fg-strong">
          {product.shortName}
        </p>
        <p className="text-[12px] font-bold text-accent-soft-fg" data-nums>
          ${product.price}
        </p>
      </div>
    </div>
  );
}

function DashboardEmpty() {
  return (
    <div className="flex min-h-[440px] flex-col items-center justify-center gap-7 rounded-2xl border border-border bg-surface px-6 py-16 text-center">
      <div className="flex items-end justify-center gap-2.5 sm:gap-3" aria-hidden>
        {EXAMPLE_PRODUCTS.map((product) => (
          <EmptyPreviewCard key={product.slug} product={product} />
        ))}
      </div>
      <div className="flex flex-col items-center gap-2">
        <h2 className="font-display text-[20px] font-bold tracking-tight text-fg-strong">
          List your first item
        </h2>
        <p className="max-w-sm text-[15px] leading-relaxed text-muted">
          Take a photo of something you want to sell and we’ll identify it,
          research the price, and write the listing for you.
        </p>
      </div>
      <Link
        href="/upload"
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[14px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover"
      >
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
        New listing
      </Link>
    </div>
  );
}

/** Dash-accented small-caps eyebrow — shared lifecycle-screen section label. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-faint">
      <span aria-hidden className="h-[2px] w-6 rounded-full bg-accent" />
      {children}
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
  filter: DashboardFilterKey;
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

  // Portfolio signal for the header summary — what the whole shop is worth.
  const totalValue = rows.reduce((sum, r) => sum + (r.price ?? 0), 0);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 pb-10 pt-8 sm:px-6 sm:pt-10">
      {/* ---- page header: eyebrow + title, with a portfolio-value summary ---- */}
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Eyebrow>Your shop</Eyebrow>
          <h1 className="mt-1.5 font-display text-[24px] font-bold tracking-tight text-fg-strong">
            Listings
          </h1>
        </div>
        {rows.length > 0 ? (
          <div className="flex items-center gap-4 rounded-xl border border-border bg-surface px-4 py-2 shadow-xs">
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-faint">Items</p>
              <p className="font-display text-[18px] font-bold text-fg-strong" data-nums>
                <CountUp to={rows.length} duration={0.7} />
              </p>
            </div>
            <span aria-hidden className="h-7 w-px bg-border" />
            <div>
              <p className="text-[11px] uppercase tracking-[0.12em] text-faint">
                Total value
              </p>
              <p className="font-display text-[18px] font-bold text-fg-strong" data-nums>
                {PRICE_FMT.format(totalValue)}
              </p>
            </div>
          </div>
        ) : null}
      </header>

      {rows.length === 0 ? (
        <DashboardEmpty />
      ) : (
        <>
          {/* ---- filter tab strip (minimal: a quiet underline tab row, label +
               inline count, accent underline on the active one — no 5 boxes) ---- */}
          <nav
            aria-label="Filter by status"
            className="-mx-4 flex gap-1 overflow-x-auto border-b border-border px-4 [scrollbar-width:none] sm:mx-0 sm:px-0"
          >
            {DASHBOARD_FILTERS.map((f) => {
              const active = f.key === filter;
              return (
                <Link
                  key={f.key}
                  href={f.key === "all" ? "/dashboard" : `/dashboard?filter=${f.key}`}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex shrink-0 items-baseline gap-2 whitespace-nowrap px-3 py-2.5 text-[14px] transition-colors ${
                    active ? "text-fg-strong" : "text-muted hover:text-fg"
                  }`}
                >
                  <span className="font-medium">{f.label}</span>
                  <span
                    className={`text-[13px] font-semibold ${
                      active ? "text-accent-soft-fg" : "text-faint"
                    }`}
                    data-nums
                  >
                    <CountUp to={filterCount(f)} duration={0.7} />
                  </span>
                  {active ? (
                    <span
                      aria-hidden
                      className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-accent"
                    />
                  ) : null}
                </Link>
              );
            })}
          </nav>

          {/* ---- table card ---- */}
          <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-xs">
            {/* toolbar: inline search over the active tab */}
            <div className="flex items-center gap-3 border-b border-border px-3 py-2.5">
              <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[14px] focus-within:ring-2 focus-within:ring-accent/40 sm:max-w-xs">
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
                    className="-mr-1.5 flex size-9 shrink-0 items-center justify-center rounded text-faint transition-colors hover:text-fg"
                  >
                    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                ) : null}
              </label>
              {searching ? (
                <span className="shrink-0 text-[13.5px] text-muted" data-nums>
                  {visible.length} match{visible.length === 1 ? "" : "es"}
                </span>
              ) : null}
            </div>

            {visible.length === 0 ? (
              searching ? (
                <p className="px-4 py-10 text-center text-[15px] text-muted">
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
                <p className="px-4 py-10 text-center text-[15px] text-muted">
                  Nothing under “{activeFilter.label}” yet. Items move here as their
                  status changes.
                </p>
              )
            ) : (
              <>
                {/* desktop: Shopify data table */}
                <table className="hidden w-full sm:table">
                  <thead>
                    <tr className="border-b border-border text-left text-[12px] font-semibold uppercase tracking-[0.08em] text-faint">
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
                              <span className="truncate text-[14px] font-semibold text-fg-strong group-hover:underline">
                                {row.title}
                              </span>
                            </Link>
                          </td>
                          <td className="px-2 py-2">
                            {chip ? (
                              <StatusBadge label={chip.label} tone={chip.tone} dot={false} />
                            ) : null}
                          </td>
                          <td className="px-2 py-2 text-right text-[14px] font-semibold text-fg-strong" data-nums>
                            {row.price != null ? PRICE_FMT.format(row.price) : <span className="font-normal text-faint">–</span>}
                          </td>
                          {/* suppressHydrationWarning: relative dates are
                              computed in the server's TZ during SSR and the
                              user's TZ after hydration — they may differ
                              around midnight, by design. */}
                          <td
                            className="py-2 pl-2 text-right text-[14px] text-muted"
                            data-nums
                            suppressHydrationWarning
                          >
                            {row.createdAt ? relativeDay(row.createdAt) : "–"}
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
                            <span className="block truncate text-[15px] font-semibold text-fg-strong">
                              {row.title}
                            </span>
                            <span
                              className="mt-0.5 block text-[13.5px] text-muted"
                              data-nums
                              suppressHydrationWarning
                            >
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
