"use client";

import Link from "next/link";
import { useState } from "react";
import CountUp from "@/components/bits/CountUp";
import Folder from "@/components/bits/Folder";
import { DEMO_PRODUCTS_BY_SLUG, type DemoProduct } from "@/lib/demo-products";
import { StatusBadge } from "@/components/ui/badge";
import { lifecycleShortLabel } from "@/lib/ui/status";
import { matchesQuery } from "@/lib/ui/search";
import { DASHBOARD_FILTERS, type DashboardFilterKey } from "./filters";

/**
 * Dashboard — photo-forward listing grid (neutral + green exemplar; grounded in
 * the Shopify Products index, `asset-intake/Shopify web Jan 2024/320`). The
 * seller's shop reads as a wall of their own items: each listing is an
 * image-first card (cover photo · title · price · calm status pill) linking to
 * the review page. Shopify's quiet underline tab strip filters by status (with
 * live CountUp counts), and an inset search field filters the active tab inline.
 * The empty state keeps the react-bits Folder; CountUp drives the tab counts.
 *
 * Density / spacing / hierarchy follow the Shopify reference + the design-
 * principles skill: 4-pt rhythm, one corner-radius scale, restrained effects
 * (hairline borders + soft shadow, no glows), near-black primary, green as the
 * single accent. Mobile-first: 2-col grid → 3-col (sm) → 4-col (lg).
 *
 * Client component, still pure presentation over serializable props: the page
 * assembles rows; the preview harness feeds fixtures.
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

function PhotoPlaceholder() {
  return (
    <span
      aria-hidden
      className="flex size-full flex-col items-center justify-center gap-1.5 text-faint"
    >
      <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
      </svg>
      <span className="text-[11px] font-medium tracking-wide">Processing</span>
    </span>
  );
}

/**
 * One listing card — image-first, links to the review/inspect page. Falls back
 * to a labeled placeholder when an item has no photo yet (still processing).
 * Hierarchy (design skill): the photo leads, then the title, then price + a
 * single calm status pill on one baseline. Hover lifts with a soft shadow and a
 * restrained image zoom — no glow.
 */
function ListingCard({ row }: { row: DashboardRow }) {
  const chip = lifecycleShortLabel(row.status);
  return (
    <Link
      href={`/review/${row.itemId}`}
      className="group flex h-full flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-xs transition-[box-shadow,border-color,transform] duration-200 hover:-translate-y-px hover:border-border-strong hover:shadow-md motion-safe:active:scale-[0.99]"
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-surface-2">
        {row.thumbUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL
          <img
            src={row.thumbUrl}
            alt=""
            aria-hidden
            className="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.04]"
          />
        ) : (
          <PhotoPlaceholder />
        )}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <p className="line-clamp-2 text-[13.5px] font-semibold leading-snug text-fg-strong group-hover:underline">
          {row.title}
        </p>
        <div className="mt-auto flex items-center justify-between gap-2 pt-0.5">
          <p className="text-[15px] font-bold text-fg-strong" data-nums>
            {row.price != null ? (
              PRICE_FMT.format(row.price)
            ) : (
              <span className="text-[13px] font-normal text-faint">No price yet</span>
            )}
          </p>
          {chip ? <StatusBadge label={chip.label} tone={chip.tone} dot /> : null}
        </div>
      </div>
    </Link>
  );
}

/**
 * Empty dashboard — react-bits Folder (now green to match the accent ramp)
 * holding miniature LISTING PREVIEWS pulled straight from the demo catalog
 * (image + name + price always come from the SAME DemoProduct, so a photo can
 * never carry another item's label — round-5 owner trust fix). The opened folder
 * reads as "this is what your listings will become". Click/hover plays with the
 * papers.
 *
 * Items picked exclusive to the dashboard: kettlebell, binoculars, sewing
 * machine — none appear on any marketing surface.
 */
const FOLDER_ITEMS: DemoProduct[] = [
  // Order matters: paper 0 is the narrowest, paper 2 the widest — the longest
  // short-name (Sewing machine) rides the wide paper so nothing truncates.
  DEMO_PRODUCTS_BY_SLUG.kettlebell,
  DEMO_PRODUCTS_BY_SLUG.binoculars,
  DEMO_PRODUCTS_BY_SLUG.sewingmachine,
];

function MiniListingCard({ product }: { product: DemoProduct }) {
  return (
    /* The folder papers stay literal white paper in both themes, so their ink
       is pinned (fg-strong / accent-soft-fg flip light in dark mode and would
       wash out on the white card). Sizes look tiny here but render ~2.2× via
       the Folder scale transform. */
    <span className="flex size-full flex-col overflow-hidden rounded-[10px] border border-border/60 bg-white text-left shadow-sm dark:border-white/20">
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny static demo thumbnail inside the folder animation */}
      <img
        src={product.image}
        alt=""
        aria-hidden
        className="h-[58%] w-full object-cover"
      />
      <span className="flex min-h-0 flex-1 flex-col justify-center gap-[2px] px-[5px]">
        <span className="block truncate text-[6.5px] font-semibold leading-[1.2] text-[#131e3a]">
          {product.shortName}
        </span>
        <span className="block text-[7.5px] font-bold leading-none text-[#006e52]" data-nums>
          ${product.price}
        </span>
      </span>
    </span>
  );
}

function DashboardEmpty() {
  return (
    <div className="flex min-h-[560px] flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border-strong bg-surface px-6 py-12 text-center">
      {/* The folder block is vertically CENTERED in the container (justify-center
          + min-h), not pushed down with a void above it. mb-14 sets the gap to
          the title. */}
      <div className="mb-14">
        <Folder
          color="#008060"
          size={2.2}
          items={FOLDER_ITEMS.map((product) => (
            <MiniListingCard key={product.slug} product={product} />
          ))}
        />
      </div>
      <p className="text-base font-semibold text-fg-strong">List your first item</p>
      <p className="max-w-sm text-[15px] text-muted">
        Take a photo of something you want to sell and we&apos;ll identify it,
        research the price, and write the listing for you.
      </p>
      <div className="mt-1">
        <Link
          href="/upload"
          className="inline-flex items-center rounded-lg bg-primary px-3.5 py-2 text-[14px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover"
        >
          New listing
        </Link>
      </div>
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

// `counts` stays in the props API for the page/preview callers, but the tab
// counts are computed from `rows` directly.
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

  // Cap the stagger so a long shop doesn't crawl in.
  const enterDelay = (i: number) => `${Math.min(i, 10) * 30}ms`;

  // Portfolio signal for the header summary — what the whole shop is worth.
  const totalValue = rows.reduce((sum, r) => sum + (r.price ?? 0), 0);

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 pb-12 pt-8 sm:px-6 sm:pt-10">
      {/* ---- page header: eyebrow + title + portfolio summary, with the primary
           "New listing" action top-right (Shopify "Add product" pattern) ---- */}
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div>
          <Eyebrow>Your shop</Eyebrow>
          <h1 className="mt-1.5 font-display text-[24px] font-bold tracking-tight text-fg-strong">
            Listings
          </h1>
          {rows.length > 0 ? (
            <p className="mt-1 text-[13px] text-muted" data-nums>
              <CountUp to={rows.length} duration={0.7} /> item{rows.length === 1 ? "" : "s"} ·{" "}
              {PRICE_FMT.format(totalValue)} total
            </p>
          ) : null}
        </div>
        {rows.length > 0 ? (
          <Link
            href="/upload"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[14px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover motion-safe:active:scale-[0.98]"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            New listing
          </Link>
        ) : null}
      </header>

      {rows.length === 0 ? (
        <DashboardEmpty />
      ) : (
        <>
          {/* ---- toolbar: quiet underline tab strip (Shopify Products) + inline
               live search over the active tab ---- */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border">
            <nav
              aria-label="Filter by status"
              className="-mx-1 flex gap-1 overflow-x-auto [scrollbar-width:none]"
            >
              {DASHBOARD_FILTERS.map((f) => {
                const active = f.key === filter;
                return (
                  <Link
                    key={f.key}
                    href={f.key === "all" ? "/dashboard" : `/dashboard?filter=${f.key}`}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex shrink-0 items-baseline gap-1.5 whitespace-nowrap px-3 py-2.5 text-[13.5px] transition-colors ${
                      active ? "text-fg-strong" : "text-muted hover:text-fg"
                    }`}
                  >
                    <span className="font-medium">{f.label}</span>
                    <span
                      className={`text-[12.5px] ${active ? "text-accent-soft-fg" : "text-faint"}`}
                      data-nums
                    >
                      <CountUp to={filterCount(f)} duration={0.7} />
                    </span>
                    {active ? (
                      <span
                        aria-hidden
                        className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-accent"
                      />
                    ) : null}
                  </Link>
                );
              })}
            </nav>
            <label className="mb-2 flex w-full items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[14px] focus-within:ring-2 focus-within:ring-accent/40 sm:mb-1.5 sm:w-56">
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
                  className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-faint transition-colors hover:text-fg"
                >
                  <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              ) : null}
            </label>
          </div>

          {visible.length === 0 ? (
            searching ? (
              <p className="px-4 py-12 text-center text-[15px] text-muted">
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
              <p className="px-4 py-12 text-center text-[15px] text-muted">
                Nothing under “{activeFilter.label}” yet. Items move here as their
                status changes.
              </p>
            )
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
              {visible.map((row, i) => (
                <li
                  key={`${row.itemId}-${row.listingId ?? "item"}`}
                  className="row-enter"
                  style={{ animationDelay: enterDelay(i) }}
                >
                  <ListingCard row={row} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
