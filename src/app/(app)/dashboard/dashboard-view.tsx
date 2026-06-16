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
 * Dashboard — Shopify **Products index** layout (neutral + green; grounded in
 * `asset-intake/Shopify web Jan 2024/320`). The seller's shop is a dense,
 * scannable LIST (not a photo wall): each listing is a compact row — small cover
 * thumbnail · title · calm status pill · price · listed date — linking to the
 * review page. Above it, Shopify's quiet underline tab strip filters by status
 * (with live CountUp counts) and an inset field filters the active tab inline.
 *
 * Sorting (the seller can re-order): the column headers are sort controls
 * (Product / Status / Price / Listed), click to sort, click again to flip — a
 * caret marks the active column. The default "smart" order is action-first
 * (errors → drafts → automatic states → live), so the work that needs the seller
 * is on top until they choose otherwise. Dates render in a STABLE UTC format
 * ("Jun 12") — never `Date.now()`/locale — so the server and client markup match
 * (no hydration drift).
 *
 * Density / spacing / hierarchy follow the Shopify reference + the design-
 * principles skill: 4-pt rhythm, one corner-radius scale, hairline row dividers,
 * near-black primary, green as the single accent. Mobile collapses each row to a
 * two-line card (thumb · title+meta · price); sm+ shows the aligned table.
 *
 * Client component, pure presentation over serializable props: the page
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

/** The states the SELLER must act on — used for the header summary + the
 *  default action-first ordering. Mirrors the "Needs review" filter. */
const REVIEW_STATUSES = new Set(["draft", "draft_failed", "failed"]);

/** Default ("smart") reading order: errors first, then drafts, then the
 *  automatic states (Processing → Scheduled), then settled Live items. Unknown
 *  keys sort after drafts but before the automatic states (see `rank()`). */
const STATUS_RANK: Record<string, number> = {
  failed: 0,
  draft_failed: 0,
  draft: 1,
  new: 2,
  queued: 3,
  published: 4,
};
const rank = (status: string) => STATUS_RANK[status] ?? 1.5;

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
/** Stable "MMM D" from an ISO date, computed in UTC so SSR and client agree
 *  (avoids a Next hydration mismatch — no Date.now()/toLocaleDateString). */
function listedLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

// ---- sorting ----------------------------------------------------------------

type SortKey = "smart" | "title" | "status" | "price" | "date";
interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}
/** The default direction a column opens in when first clicked. */
const DEFAULT_DIR: Record<Exclude<SortKey, "smart">, "asc" | "desc"> = {
  title: "asc",
  status: "asc", // asc = action-first (low rank first)
  price: "desc", // most valuable first
  date: "desc", // newest first
};

function compareRows(a: DashboardRow, b: DashboardRow, sort: SortState): number {
  const dir = sort.dir === "asc" ? 1 : -1;
  switch (sort.key) {
    case "title":
      return a.title.localeCompare(b.title) * dir;
    case "status":
      return (rank(a.status) - rank(b.status)) * dir;
    case "price":
      // Items without a price sink to the bottom regardless of direction.
      return ((a.price ?? -Infinity) - (b.price ?? -Infinity)) * dir;
    case "date":
      return (Date.parse(a.createdAt) - Date.parse(b.createdAt)) * dir;
    default:
      // "smart": action-first, then newest within each rank.
      return (
        rank(a.status) - rank(b.status) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt)
      );
  }
}

function PhotoPlaceholder() {
  return (
    <span
      aria-hidden
      className="flex size-full items-center justify-center text-faint"
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
      </svg>
    </span>
  );
}

/** Shared desktop column template — used by the header row AND every data row
 *  so the columns line up exactly. Product is flexible; the rest are fixed. */
const ROW_GRID = "sm:grid sm:grid-cols-[1fr_148px_104px_92px] sm:items-center sm:gap-4";

/**
 * One listing row — a Shopify products-index row that links to the review page.
 * Mobile: a compact card (thumb · title over status+date · price on the right).
 * sm+: the aligned table columns (Product · Status · Price · Listed).
 */
function ListingRow({ row }: { row: DashboardRow }) {
  const chip = lifecycleShortLabel(row.status);
  return (
    <Link
      href={`/review/${row.itemId}`}
      className={`group flex items-center gap-3 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-surface-2 ${ROW_GRID} sm:px-3`}
    >
      {/* Product cell: cover thumbnail + title (+ mobile-only meta line). */}
      <div className="flex min-w-0 flex-1 items-center gap-3 sm:flex-none">
        <span className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-border bg-surface-2">
          {row.thumbUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL
            <img
              src={row.thumbUrl}
              alt=""
              aria-hidden
              className="size-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.05]"
            />
          ) : (
            <PhotoPlaceholder />
          )}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[14px] font-semibold leading-snug text-fg-strong group-hover:underline">
            {row.title}
          </p>
          {/* Mobile-only meta: status + listed date under the title. */}
          <div className="mt-1 flex items-center gap-2 sm:hidden">
            {chip ? <StatusBadge label={chip.label} tone={chip.tone} dot /> : null}
            <span className="text-[12px] text-faint" data-nums>
              {listedLabel(row.createdAt)}
            </span>
          </div>
        </div>
      </div>

      {/* Mobile-only price on the right of the row. */}
      <p className="shrink-0 text-[15px] font-bold text-fg-strong sm:hidden" data-nums>
        {row.price != null ? (
          PRICE_FMT.format(row.price)
        ) : (
          <span className="text-[12px] font-normal text-faint">No price</span>
        )}
      </p>

      {/* Desktop columns. */}
      <span className="hidden sm:flex">
        {chip ? <StatusBadge label={chip.label} tone={chip.tone} dot /> : null}
      </span>
      <p className="hidden text-right text-[14px] font-bold text-fg-strong sm:block" data-nums>
        {row.price != null ? (
          PRICE_FMT.format(row.price)
        ) : (
          <span className="text-[13px] font-normal text-faint">—</span>
        )}
      </p>
      <span className="hidden text-right text-[13px] text-muted sm:block" data-nums>
        {listedLabel(row.createdAt)}
      </span>
    </Link>
  );
}

/** Sortable column header (desktop only). Shows a caret on the active column
 *  pointing the sort direction; clicking flips direction, clicking a new column
 *  opens it in its natural default direction. */
function SortHeader({
  label,
  k,
  sort,
  onSort,
  align = "left",
}: {
  label: string;
  k: Exclude<SortKey, "smart">;
  sort: SortState;
  onSort: (k: Exclude<SortKey, "smart">) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === k;
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      aria-label={
        active
          ? `Sorted by ${label}, ${sort.dir === "asc" ? "ascending" : "descending"}. Activate to reverse.`
          : `Sort by ${label}`
      }
      className={`flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.08em] transition-colors ${
        align === "right" ? "justify-end" : ""
      } ${active ? "text-fg-strong" : "text-faint hover:text-fg"}`}
    >
      {label}
      <svg
        viewBox="0 0 24 24"
        className={`size-3 transition-[transform,opacity] ${
          active ? "opacity-100" : "opacity-0 group-hover/head:opacity-40"
        } ${active && sort.dir === "asc" ? "rotate-180" : ""}`}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>
  );
}

/**
 * Empty dashboard — react-bits Folder (green to match the accent) holding
 * miniature LISTING PREVIEWS pulled from the demo catalog (image + name + price
 * always from the SAME DemoProduct, so a photo can never carry another item's
 * label). The opened folder reads as "this is what your listings will become".
 */
const FOLDER_ITEMS: DemoProduct[] = [
  DEMO_PRODUCTS_BY_SLUG.kettlebell,
  DEMO_PRODUCTS_BY_SLUG.binoculars,
  DEMO_PRODUCTS_BY_SLUG.sewingmachine,
];

function MiniListingCard({ product }: { product: DemoProduct }) {
  return (
    <span className="flex size-full flex-col overflow-hidden rounded-[10px] border border-border/60 bg-white text-left shadow-sm dark:border-white/20">
      {/* eslint-disable-next-line @next/next/no-img-element -- tiny static demo thumbnail inside the folder animation */}
      <img
        src={product.image}
        alt=""
        aria-hidden
        className="h-[58%] w-full object-cover"
      />
      <span className="flex min-h-0 flex-1 flex-col justify-center gap-[2px] px-[5px]">
        <span className="block truncate text-[6.5px] font-semibold leading-[1.2] text-[#1a1a1a]">
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
  const [sort, setSort] = useState<SortState>({ key: "smart", dir: "asc" });

  const onSort = (k: Exclude<SortKey, "smart">) =>
    setSort((prev) =>
      prev.key === k
        ? { key: k, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key: k, dir: DEFAULT_DIR[k] },
    );

  const activeFilter =
    DASHBOARD_FILTERS.find((f) => f.key === filter) ?? DASHBOARD_FILTERS[0];
  const statusFiltered = activeFilter.statuses
    ? rows.filter((r) => activeFilter.statuses!.includes(r.status))
    : rows;
  const visible = statusFiltered
    .filter((r) => matchesQuery(r.title, query))
    .slice()
    .sort((a, b) => compareRows(a, b, sort));
  const searching = query.trim() !== "";

  const filterCount = (f: (typeof DASHBOARD_FILTERS)[number]) =>
    f.statuses ? rows.filter((r) => f.statuses!.includes(r.status)).length : rows.length;

  // Cap the stagger so a long shop doesn't crawl in.
  const enterDelay = (i: number) => `${Math.min(i, 12) * 24}ms`;

  // Header summary leads with what needs the seller, not just the headcount.
  const totalValue = rows.reduce((sum, r) => sum + (r.price ?? 0), 0);
  const reviewCount = rows.filter((r) => REVIEW_STATUSES.has(r.status)).length;
  const liveCount = rows.filter((r) => r.status === "published").length;

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
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted" data-nums>
              {reviewCount > 0 ? (
                <span className="font-semibold text-fg-strong">
                  <CountUp to={reviewCount} duration={0.7} /> need
                  {reviewCount === 1 ? "s" : ""} review
                </span>
              ) : (
                <span className="font-medium text-fg">All caught up</span>
              )}
              <span aria-hidden className="text-faint">·</span>
              <span>
                <CountUp to={liveCount} duration={0.7} /> live
              </span>
              <span aria-hidden className="text-faint">·</span>
              <span>{PRICE_FMT.format(totalValue)} total</span>
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
        <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-xs">
          {/* ---- toolbar: quiet underline tab strip (Shopify Products) + inline
               live search over the active tab ---- */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-2 sm:px-3">
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
            <>
              {/* ---- sortable column headers (desktop) — Shopify's table head ---- */}
              <div className={`group/head hidden border-b border-border px-3 py-2 ${ROW_GRID}`}>
                <SortHeader label="Product" k="title" sort={sort} onSort={onSort} />
                <SortHeader label="Status" k="status" sort={sort} onSort={onSort} />
                <SortHeader label="Price" k="price" sort={sort} onSort={onSort} align="right" />
                <SortHeader label="Listed" k="date" sort={sort} onSort={onSort} align="right" />
              </div>

              <ul className="divide-y divide-border px-1 py-1">
                {visible.map((row, i) => (
                  <li
                    key={`${row.itemId}-${row.listingId ?? "item"}`}
                    className="row-enter"
                    style={{ animationDelay: enterDelay(i) }}
                  >
                    <ListingRow row={row} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </main>
  );
}
