"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import Folder from "@/components/bits/Folder";
import { menuArrowNav, useEscapeToClose, useModalFocus } from "@/components/ui/overlay-behavior";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DEMO_PRODUCTS_BY_SLUG, type DemoProduct } from "@/lib/demo-products";
import { StatusBadge } from "@/components/ui/badge";
import { lifecycleShortLabel } from "@/lib/ui/status";
import { matchesQuery } from "@/lib/ui/search";
import { DASHBOARD_FILTERS, type DashboardFilterKey } from "./filters";
import type { BulkListingUpdate } from "./actions";
import { BulkEditGrid } from "./bulk-edit-grid";
import { ProfitSummary, RowNetProfit } from "./profit";

/**
 * Dashboard — Shopify **Products index** (grounded in asset-intake #320 + the
 * Mobbin products flows). A dense, scannable LIST: each listing is a row —
 * select checkbox · cover thumbnail · title · status pill · price · listed date
 * — linking to review. Above it: Shopify's underline tab strip (status views,
 * incl. Archived), an inline title search, and a **Sort** menu. Selecting rows
 * raises a floating **bulk action bar** (Archive / Delete) with a confirm dialog
 * + toast, mirroring Shopify's bulk-edit flow.
 *
 * Mutations are RLS-safe server actions passed from the page (archive /
 * unarchive / delete / bulk quick-edit). Dates render in stable UTC ("MMM D")
 * so SSR and client markup agree (no hydration drift). Mobile collapses each
 * row to a two-line card.
 *
 * Client component, presentation + selection state over serializable props.
 */

export interface DashboardRow {
  itemId: string;
  listingId: string | null;
  title: string;
  status: string;
  createdAt: string;
  price: number | null;
  /** What the seller paid (#101); null = unknown → the row shows price only. */
  costBasis: number | null;
  thumbUrl: string | null;
  /** Item facets surfaced as their own columns + search filters (Shopify
   *  Products parity). Null when the pipeline couldn't resolve them. */
  category: string | null;
  condition: string | null;
}

export interface DashboardCounts {
  draft: number;
  attention: number;
  live: number;
}

type IdsAction = (ids: string[]) => Promise<void>;

/** Whole dollars stay clean ("$800"); anything with cents gets BOTH digits
 *  ("$514.50", never "$514.5" — a half-formatted price reads as a glitch on a
 *  money surface; audit #105). */
const PRICE_FMT_WHOLE = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});
const PRICE_FMT_CENTS = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const fmtPrice = (n: number) =>
  (Number.isInteger(n) ? PRICE_FMT_WHOLE : PRICE_FMT_CENTS).format(n);

/** Default ("smart") order: errors → drafts → automatic states → live →
 *  archived. Unknown keys sort with drafts. */
const STATUS_RANK: Record<string, number> = {
  failed: 0,
  draft_failed: 0,
  draft: 1,
  new: 2,
  queued: 3,
  published: 4,
  archived: 5,
};
const rank = (status: string) => STATUS_RANK[status] ?? 1.5;

const SHORT_MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
/** Stable "MMM D" from an ISO date, computed in UTC so SSR and client agree. */
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
const DEFAULT_DIR: Record<Exclude<SortKey, "smart">, "asc" | "desc"> = {
  title: "asc",
  status: "asc",
  price: "desc",
  date: "desc",
};
const SORT_OPTIONS: { key: Exclude<SortKey, "smart">; label: string }[] = [
  { key: "title", label: "Product title" },
  { key: "price", label: "Price" },
  { key: "date", label: "Date listed" },
  { key: "status", label: "Status" },
];

/** Status options for the search-mode filter chip (Shopify's "Status" filter):
 *  every view tab except "All". The chip multi-selects these and unions their
 *  statuses, so search can filter by status independently of the view tabs. */
const STATUS_CHIP_OPTIONS = DASHBOARD_FILTERS.filter((f) => f.key !== "all");

function compareRows(a: DashboardRow, b: DashboardRow, sort: SortState): number {
  const dir = sort.dir === "asc" ? 1 : -1;
  switch (sort.key) {
    case "title":
      return a.title.localeCompare(b.title) * dir;
    case "status":
      return (rank(a.status) - rank(b.status)) * dir;
    case "price":
      return ((a.price ?? -Infinity) - (b.price ?? -Infinity)) * dir;
    case "date":
      return (Date.parse(a.createdAt) - Date.parse(b.createdAt)) * dir;
    default:
      return (
        rank(a.status) - rank(b.status) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt)
      );
  }
}

// ---- small icons ------------------------------------------------------------

function CheckIcon({ className = "size-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function PhotoPlaceholder() {
  return (
    <span aria-hidden className="flex size-full items-center justify-center text-faint">
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
      </svg>
    </span>
  );
}

/** Selection checkbox — a button (NOT nested in the row's <a>, so it's valid
 *  HTML and its click never navigates). */
function RowCheckbox({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  // The visible box stays 18px, but the BUTTON is a 44×44 tap target on touch
  // (WCAG 2.5.5) and shrinks to the box on pointer screens (sm+), where the row
  // itself is the large target. The width difference is absorbed by the grid's
  // `auto` checkbox column (same width in header + rows), so nothing misaligns.
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className="group/cb flex size-11 shrink-0 items-center justify-center sm:size-[18px]"
    >
      <span
        className={`flex size-[18px] items-center justify-center rounded-[5px] border transition-colors ${
          checked
            ? "border-accent-solid bg-accent-solid text-accent-fg"
            : "border-border-strong bg-surface group-hover/cb:border-fg-strong"
        }`}
      >
        {checked ? <CheckIcon className="size-3" /> : null}
      </span>
    </button>
  );
}

/** Shared column template (header + rows align), Shopify Products parity:
 *  select · Product · Status · Category · Condition · Price · Listed. Columns
 *  disclose progressively so narrow screens never crowd — least-important
 *  first to drop:
 *    md  (≥768):  select · Product · Status · Price
 *    lg  (≥1024): + Listed
 *    xl  (≥1280): + Category + Condition
 *  Below md the row is a stacked card (the base `grid-cols-[auto_1fr_auto]`).
 *  Cell visibility classes (`hidden md/lg/xl:block`) MUST stay in sync with
 *  these track counts or the grid columns misalign. Data columns are EQUAL
 *  fixed widths (`repeat(n, 120px)`) and every value is CENTER-aligned, so each
 *  value sits on its column's midpoint and the rhythm stays even.
 *
 *  The title track is `minmax(8rem,1fr)`, NOT `minmax(0,1fr)` (audit #105):
 *  the zero floor let the fixed columns crush the product name to 5px on
 *  tablet widths — the dashboard's primary identifier disappeared entirely
 *  between ~768–900px. The fixed-column budget per breakpoint is sized so
 *  8rem always fits the narrowest container of its band (md ≈ 471px content
 *  width with 2×120px columns; lg ≈ 727px with 3; xl ≈ 942px with 5). */
const ROW_GRID =
  "md:grid md:items-center md:gap-5 md:grid-cols-[auto_minmax(8rem,1fr)_repeat(2,120px)] " +
  "lg:grid-cols-[auto_minmax(8rem,1fr)_repeat(3,120px)] " +
  "xl:grid-cols-[auto_minmax(8rem,1fr)_repeat(5,120px)]";

/**
 * One listing row. The whole row links to review (the inner <a> is
 * `display:contents`, so its children are the grid cells and a click anywhere
 * navigates), while the leading checkbox sits outside the link.
 *
 * Cell order is fixed — Product · Status · Category · Condition · (mobile
 * price) · Price · Listed — and each cell carries the responsive visibility
 * that matches `ROW_GRID`'s track count at each breakpoint. Below md the row
 * is a stacked card: thumb + title, a meta line (status · category · condition
 * · date), and the price on the right.
 */
function ListingRow({
  row,
  selected,
  onToggle,
}: {
  row: DashboardRow;
  selected: boolean;
  onToggle: () => void;
}) {
  const chip = lifecycleShortLabel(row.status);
  return (
    <div
      // Hover/selection are NEUTRAL tints (audit #105): the reserved green now
      // marks only nav-active / Live / positive states, so it never competes
      // with a real status signal. Selection reads one step deeper than hover.
      className={`group/row relative grid grid-cols-[auto_1fr_auto] items-center gap-3.5 rounded-lg px-2.5 py-3 transition-colors duration-150 hover:bg-surface-2 active:bg-surface-3 md:px-4 md:py-2.5 lg:px-5 lg:py-2.5 ${ROW_GRID} ${
        selected ? "bg-surface-3/70" : ""
      }`}
    >
      {/* Above the stretched link so it stays clickable. */}
      <span className="relative z-[2] flex">
        <RowCheckbox checked={selected} onToggle={onToggle} label={`Select ${row.title}`} />
      </span>

      {/* Whole-row navigation as a STRETCHED overlay link (not
          `display:contents` — a contents anchor is unfocusable in Chromium, so
          keyboard users couldn't open a listing at all; audit #105). The box
          also gives the global :focus-visible outline something to draw
          around, so Tab shows exactly which row is active. */}
      <Link
        href={`/review/${row.itemId}`}
        className="absolute inset-0 z-[1] rounded-lg"
        aria-label={`Open ${row.title}`}
      />

      {/* Product cell: cover thumbnail + title. Status/category/condition are
          their own columns at md+; the mobile meta line below carries them. */}
      <span className="flex min-w-0 items-center gap-3 lg:gap-4">
          <span className="relative size-14 shrink-0 overflow-hidden rounded-xl border border-border bg-surface-2 md:size-11 md:rounded-lg">
            {row.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL
              <img
                src={row.thumbUrl}
                alt=""
                aria-hidden
                className="size-full object-cover"
              />
            ) : (
              <PhotoPlaceholder />
            )}
          </span>
          <span className="min-w-0">
            <span className="block min-w-0 truncate text-[15px] font-semibold leading-snug text-fg-strong lg:text-[15.5px]">
              {row.title}
            </span>
            {/* Mobile meta — ONE quiet secondary line under the title (Shopify
                product-row hierarchy): the status chip is the single colored
                signal, then category · condition in muted ink. The created date
                was dropped here — it read as "thrown in" and added a third
                competing element at the same weight; it still lives in the
                desktop Listed column and on the item's review screen. */}
            <span className="mt-1.5 flex min-w-0 items-center gap-2 md:hidden">
              {chip ? <StatusBadge label={chip.label} tone={chip.tone} dot pulse={chip.pulse} icon={chip.icon} /> : null}
              {row.category ? (
                <span className="min-w-0 truncate text-[13px] text-muted">
                  {row.category}
                </span>
              ) : null}
            </span>
          </span>
        </span>

        {/* Status column (md+). Centered on the column midpoint. */}
        <span className="hidden md:block md:text-center">
          {chip ? <StatusBadge label={chip.label} tone={chip.tone} dot pulse={chip.pulse} icon={chip.icon} /> : null}
        </span>

        {/* Category column (xl+ — disclosed with Condition; at lg the Listed
            column takes priority so the title keeps breathing room). One
            consistent type ramp across every column — same size/weight/ink as
            the product title (owner request), center-aligned. */}
        <span className="hidden truncate text-[15px] font-semibold text-fg-strong xl:block xl:text-center">
          {row.category ?? <span className="font-normal text-faint">—</span>}
        </span>

        {/* Condition column (xl+). */}
        <span className="hidden truncate text-[15px] font-semibold text-fg-strong xl:block xl:text-center">
          {row.condition ?? <span className="font-normal text-faint">—</span>}
        </span>

        {/* Mobile/tablet price (right of the card) + projected net (#101). */}
        <span className="shrink-0 text-right text-[15px] font-semibold text-fg-strong md:hidden" data-nums>
          {row.price != null ? (
            fmtPrice(row.price)
          ) : (
            <span className="text-[12.5px] font-normal text-muted">No price</span>
          )}
          <RowNetProfit price={row.price} costBasis={row.costBasis} />
        </span>

        {/* Desktop columns: price · listed (left-aligned like every other
            column, so the row keeps one even spacing rhythm). */}
        <span className="hidden text-[15px] font-semibold text-fg-strong md:block md:text-center" data-nums>
          {row.price != null ? (
            fmtPrice(row.price)
          ) : (
            <span className="font-normal text-faint">—</span>
          )}
          <RowNetProfit price={row.price} costBasis={row.costBasis} />
        </span>
        {/* Listed column (lg+ — dropped at md so 2 fixed columns leave the
            title real width on tablets). */}
        <span className="hidden text-[15px] font-semibold text-fg-strong lg:block lg:text-center" data-nums>
          {listedLabel(row.createdAt)}
        </span>
    </div>
  );
}

/** Sortable column header (desktop). Caret marks the active column + direction. */
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
  align?: "left" | "right" | "center";
}) {
  const active = sort.key === k;
  // For right-aligned columns the caret sits BEFORE the label so the label's
  // right edge lands on the column's right edge — i.e. flush under the value
  // ($price / date) below it. (A trailing caret used to push the label left of
  // the value, which read as a misaligned column.)
  const caret = (
    <svg
      viewBox="0 0 24 24"
      className={`size-3 shrink-0 transition-[transform,opacity] ${
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
  );
  return (
    <button
      type="button"
      onClick={() => onSort(k)}
      aria-label={
        active
          ? `Sorted by ${label}, ${sort.dir === "asc" ? "ascending" : "descending"}. Activate to reverse.`
          : `Sort by ${label}`
      }
      className={`flex items-center gap-1 text-[12px] font-semibold uppercase tracking-[0.08em] transition-colors ${
        align === "right" ? "justify-end" : align === "center" ? "justify-center" : ""
      } ${active ? "text-fg-strong" : "text-muted hover:text-fg-strong"}`}
    >
      {align === "right" ? (
        <>
          {caret}
          {label}
        </>
      ) : align === "center" ? (
        // Mirror the caret's width on the leading edge so the LABEL (not the
        // label+caret group) is what centers — keeps the header text dead over
        // its centered column values.
        <>
          <span aria-hidden className="size-3 shrink-0" />
          {label}
          {caret}
        </>
      ) : (
        <>
          {label}
          {caret}
        </>
      )}
    </button>
  );
}

/** Shopify-style "Sort" popover — sets the same SortState as the headers. */
function SortMenu({
  sort,
  setSort,
  compact = false,
}: {
  sort: SortState;
  setSort: (s: SortState) => void;
  /** Icon-only trigger for the cramped mobile toolbar. Desktop shows a labeled
   *  "Sort" so it reads as a control, not a mystery glyph (recognition). */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Popover keyboard contract (#105): Esc closes (like the bell/profile menus),
  // focus moves into the menu and back to the trigger, arrows rove the items.
  useEscapeToClose(open, () => setOpen(false));
  useModalFocus(open, menuRef, { trap: false });
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Sort listings"
        className={`flex items-center rounded-lg border bg-surface shadow-xs transition-colors hover:bg-surface-2 hover:text-fg-strong ${
          compact ? "justify-center px-2.5 py-2.5" : "gap-1.5 px-3 py-2.5 text-[14px] font-medium"
        } ${open ? "border-border-strong text-fg-strong" : "border-border text-fg"}`}
      >
        <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m3 8 4-4 4 4" />
          <path d="M7 4v16" />
          <path d="m21 16-4 4-4-4" />
          <path d="M17 20V4" />
        </svg>
        {compact ? null : <span>Sort</span>}
      </button>
      {open ? (
        <>
          <button
            aria-hidden
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            ref={menuRef}
            role="menu"
            onKeyDown={menuArrowNav}
            // Anchor to the side the trigger sits on: the compact (mobile) trigger
            // is the LEFT-most toolbar item, so a right-anchored menu shot off the
            // left edge — open it leftward instead. Desktop trigger is right-aligned.
            // max-w guard keeps it on-screen on the narrowest phones either way.
            className={`menu-pop absolute z-50 mt-2 w-56 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-1.5 shadow-lg ${
              compact ? "left-0 origin-top-left" : "right-0 origin-top-right"
            }`}
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
              Sort by
            </p>
            {SORT_OPTIONS.map((o) => {
              const sel = sort.key === o.key;
              return (
                <button
                  key={o.key}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sel}
                  onClick={() => setSort({ key: o.key, dir: DEFAULT_DIR[o.key] })}
                  className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-fg transition-colors hover:bg-surface-2"
                >
                  {/* radio dot (Shopify) — thick accent ring reads as filled */}
                  <span
                    aria-hidden
                    className={`flex size-[18px] shrink-0 rounded-full transition-colors ${
                      sel ? "border-[5px] border-accent" : "border-2 border-border-strong"
                    }`}
                  />
                  {o.label}
                </button>
              );
            })}
            <div className="my-1 border-t border-border" />
            {(["asc", "desc"] as const).map((dir) => {
              const sel = sort.dir === dir;
              return (
                <button
                  key={dir}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sel}
                  onClick={() => setSort({ key: sort.key === "smart" ? "date" : sort.key, dir })}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors ${
                    sel ? "bg-surface-2 font-semibold text-fg-strong" : "text-fg hover:bg-surface-2"
                  }`}
                >
                  <svg viewBox="0 0 24 24" className="size-3.5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    {dir === "asc" ? <path d="M12 19V5M5 12l7-7 7 7" /> : <path d="M12 5v14M5 12l7 7 7-7" />}
                  </svg>
                  {dir === "asc" ? "Lowest to highest" : "Highest to lowest"}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** A filter facet shown in the search bar. Status is always present; Category
 *  and Condition are added via "+ Add filter" (Shopify Products parity). */
type FacetKey = "status" | "category" | "condition";

interface FacetOption {
  value: string;
  label: string;
}

/** Distinct, sorted non-null values from a column — feeds the Category /
 *  Condition filter options off the rows actually present (no hardcoded
 *  taxonomy), the way Shopify's vendor filter lists real vendors. */
function distinctValues(values: (string | null)[]): FacetOption[] {
  const seen = new Set<string>();
  for (const v of values) if (v) seen.add(v);
  return [...seen].sort((a, b) => a.localeCompare(b)).map((v) => ({ value: v, label: v }));
}

/**
 * One Shopify-style filter dropdown: a pill that opens a multi-select checkbox
 * popover. Inactive it shows just the label + caret; active it goes accent and
 * shows the selection ("Status: Active" / "Category: 2 selected") with an × to
 * clear. Secondary facets (Category/Condition) are `removable` — their × drops
 * the whole filter back into "+ Add filter". The popover animates in (.menu-pop).
 */
function FilterDropdown({
  label,
  options,
  selected,
  onToggle,
  onClear,
  removable,
  onRemove,
}: {
  label: string;
  options: FacetOption[];
  selected: Set<string>;
  onToggle: (value: string) => void;
  onClear: () => void;
  removable?: boolean;
  onRemove?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(open, () => setOpen(false));
  useModalFocus(open, menuRef, { trap: false });
  const count = selected.size;
  const active = count > 0;
  const summary =
    count === 0
      ? label
      : count === 1
        ? `${label}: ${options.find((o) => selected.has(o.value))?.label ?? ""}`
        : `${label}: ${count} selected`;
  return (
    <div className="relative">
      <span
        className={`flex items-center rounded-lg border text-[13.5px] font-medium transition-colors ${
          active
            ? "border-accent bg-brand-soft text-accent-soft-fg"
            : "border-border-strong text-fg hover:bg-surface-2"
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={open}
          className="flex items-center gap-1.5 py-1.5 pl-3 pr-2"
        >
          <span className="truncate">{summary}</span>
          <svg viewBox="0 0 24 24" className={`size-3.5 transition-transform ${open ? "rotate-180" : ""} ${active ? "text-accent-soft-fg" : "text-muted"}`} fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {active || removable ? (
          <button
            type="button"
            aria-label={removable ? `Remove ${label} filter` : `Clear ${label} filter`}
            onClick={() => {
              if (removable && onRemove) onRemove();
              else onClear();
            }}
            className="mr-1 flex size-5 items-center justify-center rounded text-current/70 transition-colors hover:bg-accent-soft hover:text-accent-soft-fg"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        ) : null}
      </span>
      {open ? (
        <>
          <button aria-hidden tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          <div ref={menuRef} role="menu" onKeyDown={menuArrowNav} className="menu-pop absolute left-0 z-50 mt-2 max-h-72 w-52 origin-top-left overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-lg">
            {options.length === 0 ? (
              <p className="px-2.5 py-2 text-[13px] text-muted">No options.</p>
            ) : (
              options.map((o) => {
                const on = selected.has(o.value);
                return (
                  <button
                    key={o.value}
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={on}
                    onClick={() => onToggle(o.value)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] text-fg transition-colors hover:bg-surface-2"
                  >
                    <span
                      className={`flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
                        on ? "border-accent-solid bg-accent-solid text-accent-fg" : "border-border-strong"
                      }`}
                    >
                      {on ? <CheckIcon className="size-3" /> : null}
                    </span>
                    <span className="truncate">{o.label}</span>
                  </button>
                );
              })
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

/** "+ Add filter" — Shopify's pattern for adding secondary filters. A dashed
 *  pill opening a small menu of facets not yet shown; selecting one reveals its
 *  FilterDropdown. Hidden when every facet is already shown. */
function AddFilterMenu({
  available,
  onAdd,
}: {
  available: { key: FacetKey; label: string }[];
  onAdd: (key: FacetKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(open, () => setOpen(false));
  useModalFocus(open, menuRef, { trap: false });
  if (available.length === 0) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg border border-dashed border-border-strong px-3 py-1.5 text-[13.5px] font-medium text-fg transition-colors hover:bg-surface-2"
      >
        <svg viewBox="0 0 24 24" className="size-3.5 text-muted" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
        Add filter
      </button>
      {open ? (
        <>
          <button aria-hidden tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          <div ref={menuRef} role="menu" onKeyDown={menuArrowNav} className="menu-pop absolute left-0 z-50 mt-2 w-44 origin-top-left rounded-xl border border-border bg-surface p-1.5 shadow-lg">
            {available.map((f) => (
              <button
                key={f.key}
                type="button"
                role="menuitem"
                onClick={() => {
                  onAdd(f.key);
                  setOpen(false);
                }}
                className="flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[13.5px] text-fg transition-colors hover:bg-surface-2"
              >
                {f.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Empty dashboard — react-bits Folder holding miniature listing previews from
 * the demo catalog (image + name + price from the SAME DemoProduct).
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
      <img src={product.image} alt="" aria-hidden className="h-[58%] w-full object-cover" />
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
        Take a photo of your first item and we&apos;ll identify it, price it
        from real sold listings, and write the listing for you.
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

/** Mobile bulk-bar overflow — below `sm` the bar can't fit four text actions
 *  (audit #105: Delete + Clear sat off-screen behind an invisible scroll), so
 *  the destructive/secondary actions collapse into one "More" menu that opens
 *  UPWARD (the bar hugs the bottom edge). Same popover keyboard contract as
 *  the toolbar menus. */
function BulkMoreMenu({
  canArchive,
  canUnarchive,
  pending,
  onArchive,
  onUnarchive,
  onDelete,
}: {
  canArchive: boolean;
  canUnarchive: boolean;
  pending: boolean;
  onArchive: () => void;
  onUnarchive: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(open, () => setOpen(false));
  useModalFocus(open, menuRef, { trap: false });
  const item = (label: string, onPick: () => void, opts?: { danger?: boolean; disabled?: boolean }) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      disabled={opts?.disabled}
      onClick={() => {
        setOpen(false);
        onPick();
      }}
      className={`flex w-full items-center rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors hover:bg-surface-2 disabled:opacity-50 ${
        opts?.danger ? "text-danger-soft-fg" : "text-fg"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="relative sm:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="rounded-lg px-3 py-1.5 text-[13.5px] font-semibold text-primary-fg/90 transition-colors hover:bg-primary-fg/10"
      >
        More
      </button>
      {open ? (
        <>
          <button aria-hidden tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          <div
            ref={menuRef}
            role="menu"
            onKeyDown={menuArrowNav}
            className="menu-pop absolute bottom-full right-0 z-50 mb-2 w-44 origin-bottom-right rounded-xl border border-border bg-surface p-1.5 shadow-lg"
          >
            {canArchive ? item("Archive", onArchive) : null}
            {canUnarchive ? item("Unarchive", onUnarchive, { disabled: pending }) : null}
            {item("Delete", onDelete, { danger: true })}
          </div>
        </>
      ) : null}
    </div>
  );
}

// `counts` stays in the props API for the page/preview callers, but the tab
// counts are computed from `rows` directly.
export function DashboardView({
  rows,
  filter,
  initialQuery,
  archiveAction,
  unarchiveAction,
  deleteAction,
  bulkUpdateAction,
  repriceSlot,
}: {
  rows: DashboardRow[];
  counts: DashboardCounts;
  filter: DashboardFilterKey;
  /** When the global search deep-links here (`/dashboard?q=…`), open search
   *  mode pre-filled so the two surfaces chain like Shopify's global → scoped
   *  search. */
  initialQuery?: string;
  archiveAction?: IdsAction;
  unarchiveAction?: IdsAction;
  deleteAction?: IdsAction;
  /** Batched quick-edit (price + status) — opens the full-screen grid. */
  bulkUpdateAction?: (updates: BulkListingUpdate[]) => Promise<void>;
  /** Additive slot: the stale-inventory reprice panel (issue #102). */
  repriceSlot?: ReactNode;
}) {
  const [query, setQuery] = useState(initialQuery ?? "");
  // Search MODE (the expanded Shopify search bar) is distinct from a non-empty
  // query: opening search hides the view tabs and reveals the filter dropdowns.
  const [searchMode, setSearchMode] = useState(Boolean(initialQuery?.trim()));
  // Per-facet selections. Status is always shown; category/condition appear via
  // "+ Add filter" (tracked in `extraFacets`). Status values are filter KEYS
  // (active/draft/archived) expanded to statuses; cat/cond hold literal values.
  const [filters, setFilters] = useState<Record<FacetKey, Set<string>>>({
    status: new Set(),
    category: new Set(),
    condition: new Set(),
  });
  const [extraFacets, setExtraFacets] = useState<FacetKey[]>([]);
  const [sort, setSort] = useState<SortState>({ key: "smart", dir: "asc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);
  const [quickEdit, setQuickEdit] = useState(false);
  // Mobile-only: the Shopify-style toolbar's Filter button reveals the facet
  // dropdowns inline (desktop hides them behind search mode instead).
  const [mobileFilters, setMobileFilters] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const onSortToggle = (k: Exclude<SortKey, "smart">) =>
    setSort((prev) =>
      prev.key === k
        ? { key: k, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key: k, dir: DEFAULT_DIR[k] },
    );

  const activeFilter =
    DASHBOARD_FILTERS.find((f) => f.key === filter) ?? DASHBOARD_FILTERS[0];

  // Filter options derived from the rows present (no hardcoded taxonomy).
  const statusOptions: FacetOption[] = STATUS_CHIP_OPTIONS.map((o) => ({
    value: o.key,
    label: o.label,
  }));
  const categoryOptions = useMemo(
    () => distinctValues(rows.map((r) => r.category)),
    [rows],
  );
  const conditionOptions = useMemo(
    () => distinctValues(rows.map((r) => r.condition)),
    [rows],
  );

  // While searching, the filter dropdowns drive status (Shopify hides the view
  // tabs in search mode); otherwise the active view tab does.
  const selectedStatuses =
    filters.status.size > 0
      ? STATUS_CHIP_OPTIONS.filter((o) => filters.status.has(o.key)).flatMap(
          (o) => o.statuses ?? [],
        )
      : null;
  const effectiveStatuses = searchMode ? selectedStatuses : activeFilter.statuses;

  let pool = effectiveStatuses
    ? rows.filter((r) => effectiveStatuses.includes(r.status))
    : rows;
  // Category/Condition facets apply whenever they're set. On desktop they're
  // only settable inside search mode; the mobile toolbar exposes them inline via
  // the Filter button, so gating on searchMode would make that button inert.
  if (filters.category.size > 0)
    pool = pool.filter((r) => r.category != null && filters.category.has(r.category));
  if (filters.condition.size > 0)
    pool = pool.filter((r) => r.condition != null && filters.condition.has(r.condition));
  const visible = pool
    .filter((r) => matchesQuery(r.title, query))
    .slice()
    .sort((a, b) => compareRows(a, b, sort));

  const queryActive = query.trim() !== "";
  const anyFacet =
    filters.status.size + filters.category.size + filters.condition.size > 0;
  const filtersActive = queryActive || anyFacet;

  const resetFilters = () =>
    setFilters({ status: new Set(), category: new Set(), condition: new Set() });
  const exitSearch = () => {
    setSearchMode(false);
    setQuery("");
    resetFilters();
    setExtraFacets([]);
  };
  const clearAllFilters = () => {
    setQuery("");
    resetFilters();
    setExtraFacets([]);
  };
  const toggleFacet = (key: FacetKey, value: string) =>
    setFilters((prev) => {
      const next = new Set(prev[key]);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return { ...prev, [key]: next };
    });
  const clearFacet = (key: FacetKey) =>
    setFilters((prev) => ({ ...prev, [key]: new Set() }));
  const addFacet = (key: FacetKey) =>
    setExtraFacets((prev) => (prev.includes(key) ? prev : [...prev, key]));
  const removeFacet = (key: FacetKey) => {
    setExtraFacets((prev) => prev.filter((k) => k !== key));
    clearFacet(key);
  };

  // Secondary facets still available to add (not already shown, and with
  // options to choose from).
  const availableFacets = (
    [
      { key: "category" as const, label: "Category", has: categoryOptions.length > 0 },
      { key: "condition" as const, label: "Condition", has: conditionOptions.length > 0 },
    ]
  )
    .filter((f) => f.has && !extraFacets.includes(f.key))
    .map(({ key, label }) => ({ key, label }));

  const enterDelay = (i: number) => `${Math.min(i, 12) * 24}ms`;

  // ---- selection ----
  const toggleRow = (itemId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  const visibleIds = visible.map((r) => r.itemId);
  const allSelected = visible.length > 0 && visibleIds.every((id) => selected.has(id));
  const toggleAll = () =>
    setSelected((prev) => (visibleIds.every((id) => prev.has(id)) ? new Set() : new Set(visibleIds)));
  const clearSelection = () => setSelected(new Set());

  const selectedRows = visible.filter((r) => selected.has(r.itemId));
  // Exclude live listings (status "published" = Active): archiveListings skips
  // them server-side (ending a live eBay listing is the adapter's job, not an
  // archive toggle), so including them here would make the toast claim N archived
  // when the server archived fewer. Mirroring the server guard keeps the count
  // honest and hides the Archive action when only live rows are selected.
  const archiveTargets = selectedRows
    .filter((r) => r.listingId && r.status !== "archived" && r.status !== "published")
    .map((r) => r.listingId as string);
  const unarchiveTargets = selectedRows
    .filter((r) => r.listingId && r.status === "archived")
    .map((r) => r.listingId as string);
  const deleteTargets = selectedRows.map((r) => r.itemId);

  const runArchive = () =>
    startTransition(async () => {
      await archiveAction?.(archiveTargets);
      setToast(`${archiveTargets.length} listing${archiveTargets.length === 1 ? "" : "s"} archived`);
      clearSelection();
      setConfirm(null);
    });
  const runUnarchive = () =>
    startTransition(async () => {
      await unarchiveAction?.(unarchiveTargets);
      setToast(`${unarchiveTargets.length} listing${unarchiveTargets.length === 1 ? "" : "s"} restored`);
      clearSelection();
    });
  const runDelete = () =>
    startTransition(async () => {
      await deleteAction?.(deleteTargets);
      setToast(`${deleteTargets.length} item${deleteTargets.length === 1 ? "" : "s"} deleted`);
      clearSelection();
      setConfirm(null);
    });
  const runBulkUpdate = (updates: BulkListingUpdate[]) =>
    startTransition(async () => {
      await bulkUpdateAction?.(updates);
      setToast(`${updates.length} listing${updates.length === 1 ? "" : "s"} updated`);
      setQuickEdit(false);
      clearSelection();
    });

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-5 px-4 pb-12 pt-8 sm:px-6 sm:pt-10">
      <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div>
          <h1 className="font-display text-[24px] font-bold tracking-tight text-fg-strong">
            Listings
          </h1>
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

      {repriceSlot}
      {/* #101 — invested / projected-profit band. Renders only when at least
          one active item carries a cost basis (logic lives in ./profit). */}
      {rows.length > 0 ? <ProfitSummary rows={rows} /> : null}

      {rows.length === 0 ? (
        <DashboardEmpty />
      ) : (
        <section className="rounded-xl border border-border bg-surface shadow-xs">
          {/* ---- toolbar: tab strip + sort + inline search ----
               No `overflow-hidden` on this wrapper: it would clip the Sort
               popover (absolutely positioned, escapes the section). Rows carry
               their own radius, so the rounded section still reads clean. */}
          {/* Toolbar — two modes, mirroring Shopify's Products search flow:
              default shows the view-tab pills + a search-icon + sort; clicking
              search swaps to a full-width search field with a Status filter chip
              and Cancel (the tabs hide while searching). */}
          {/* ---- mobile toolbar (Shopify Products / iOS): a DIFFERENT shape
               from the desktop two-mode toolbar — status tabs on top, then a
               persistent row of Sort · an always-expanded search · Filter, so a
               phone gets the native always-on filter bar (the Filter button
               reveals the facet dropdowns) instead of a search-button. ---- */}
          <div className="flex flex-col gap-3 rounded-t-xl border-b border-border px-3 py-3 sm:hidden">
            <nav
              aria-label="Filter by status"
              className="-mx-1 flex gap-1 overflow-x-auto px-1 [scrollbar-width:none]"
            >
              {DASHBOARD_FILTERS.map((f) => {
                const active = f.key === filter;
                return (
                  <Link
                    key={f.key}
                    href={f.key === "all" ? "/dashboard" : `/dashboard?filter=${f.key}`}
                    aria-current={active ? "page" : undefined}
                    className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-[14px] font-semibold transition-colors ${
                      active
                        ? "bg-surface-3 text-fg-strong"
                        : "text-muted hover:bg-surface-2 hover:text-fg-strong"
                    }`}
                  >
                    {f.label}
                  </Link>
                );
              })}
            </nav>
            <div className="flex items-center gap-2">
              <SortMenu sort={sort} setSort={setSort} compact />
              <label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-[15px] transition-colors focus-within:border-accent focus-within:bg-surface focus-within:ring-2 focus-within:ring-accent/25">
                <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.3-4.3" />
                </svg>
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter listings…"
                  aria-label="Filter listings by title"
                  className="w-full min-w-0 bg-transparent text-fg-strong outline-none placeholder:text-muted"
                />
                {queryActive ? (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    aria-label="Clear search text"
                    className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:text-fg-strong"
                  >
                    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
                      <path d="M18 6 6 18M6 6l12 12" />
                    </svg>
                  </button>
                ) : null}
              </label>
              <button
                type="button"
                onClick={() => setMobileFilters((v) => !v)}
                aria-label="Filter listings"
                aria-expanded={mobileFilters}
                className={`flex size-[42px] shrink-0 items-center justify-center rounded-lg border shadow-xs transition-colors ${
                  mobileFilters || anyFacet
                    ? "border-accent bg-accent-soft text-accent-soft-fg"
                    : "border-border bg-surface text-fg hover:bg-surface-2"
                }`}
              >
                <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 5h18M6 12h12M10 19h4" />
                </svg>
              </button>
            </div>
            {mobileFilters ? (
              <div className="flex flex-wrap items-center gap-2">
                {categoryOptions.length > 0 ? (
                  <FilterDropdown
                    label="Category"
                    options={categoryOptions}
                    selected={filters.category}
                    onToggle={(v) => toggleFacet("category", v)}
                    onClear={() => clearFacet("category")}
                  />
                ) : null}
                {conditionOptions.length > 0 ? (
                  <FilterDropdown
                    label="Condition"
                    options={conditionOptions}
                    selected={filters.condition}
                    onToggle={(v) => toggleFacet("condition", v)}
                    onClear={() => clearFacet("condition")}
                  />
                ) : null}
                {filtersActive ? (
                  <button
                    type="button"
                    onClick={clearAllFilters}
                    className="rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-accent-soft-fg transition-colors hover:bg-surface-2"
                  >
                    Clear all
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          <div className="hidden rounded-t-xl border-b border-border px-3 py-2.5 sm:block sm:px-4 sm:py-3">
            <AnimatePresence mode="wait" initial={false}>
            {searchMode ? (
              <motion.div
                key="search"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.11 }}
                className="flex flex-col gap-2.5"
              >
                {/* row 1: search field · Cancel · Sort (rightmost) — Shopify
                    keeps search + sort on ONE line; filters drop to row 2. The
                    field unrolls from the right (where the search button was)
                    for a smooth open. */}
                <div className="flex items-center gap-2.5">
                  <motion.label
                    initial={{ scaleX: 0.55, opacity: 0 }}
                    animate={{ scaleX: 1, opacity: 1 }}
                    exit={{ scaleX: 0.55, opacity: 0 }}
                    transition={{ duration: 0.17, ease: [0.21, 0.8, 0.32, 1] }}
                    style={{ transformOrigin: "right" }}
                    className="flex flex-1 items-center gap-2 rounded-lg border border-accent bg-surface-2 px-3.5 py-2.5 text-[15px] ring-2 ring-accent/30"
                  >
                    <svg viewBox="0 0 24 24" className="size-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.3-4.3" />
                    </svg>
                    <input
                      autoFocus
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.preventDefault();
                          exitSearch();
                        }
                      }}
                      placeholder="Searching all listings…"
                      aria-label="Search listings by title"
                      className="w-full bg-transparent text-fg-strong outline-none placeholder:text-muted"
                    />
                    {queryActive ? (
                      <button
                        type="button"
                        onClick={() => setQuery("")}
                        aria-label="Clear search text"
                        className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:text-fg-strong"
                      >
                        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                          <path d="M18 6 6 18M6 6l12 12" />
                        </svg>
                      </button>
                    ) : null}
                  </motion.label>
                  <button
                    type="button"
                    onClick={exitSearch}
                    className="shrink-0 rounded-lg px-3 py-2.5 text-[14px] font-semibold text-fg transition-colors hover:bg-surface-2"
                  >
                    Cancel
                  </button>
                  <SortMenu sort={sort} setSort={setSort} />
                </div>
                {/* row 2: filter dropdowns only (Status always; Category/
                    Condition via Add filter) + Clear all — Shopify's Products
                    filter bar sits BELOW the search/sort row. */}
                <div className="flex flex-wrap items-center gap-2">
                  <FilterDropdown
                    label="Status"
                    options={statusOptions}
                    selected={filters.status}
                    onToggle={(v) => toggleFacet("status", v)}
                    onClear={() => clearFacet("status")}
                  />
                  {extraFacets.includes("category") ? (
                    <FilterDropdown
                      label="Category"
                      options={categoryOptions}
                      selected={filters.category}
                      onToggle={(v) => toggleFacet("category", v)}
                      onClear={() => clearFacet("category")}
                      removable
                      onRemove={() => removeFacet("category")}
                    />
                  ) : null}
                  {extraFacets.includes("condition") ? (
                    <FilterDropdown
                      label="Condition"
                      options={conditionOptions}
                      selected={filters.condition}
                      onToggle={(v) => toggleFacet("condition", v)}
                      onClear={() => clearFacet("condition")}
                      removable
                      onRemove={() => removeFacet("condition")}
                    />
                  ) : null}
                  <AddFilterMenu available={availableFacets} onAdd={addFacet} />
                  {filtersActive ? (
                    <button
                      type="button"
                      onClick={clearAllFilters}
                      className="rounded-lg px-2.5 py-1.5 text-[13px] font-semibold text-accent-soft-fg transition-colors hover:bg-surface-2"
                    >
                      Clear all
                    </button>
                  ) : null}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="default"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.11 }}
                className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3"
              >
                {/* Shopify Products tab strip: a segmented pill set — the active
                    tab is a rounded gray fill (highlight, not underline) that
                    slides between tabs (layoutId). Labels only, no counts. */}
                <nav aria-label="Filter by status" className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
                  {DASHBOARD_FILTERS.map((f) => {
                    const active = f.key === filter;
                    return (
                      <Link
                        key={f.key}
                        href={f.key === "all" ? "/dashboard" : `/dashboard?filter=${f.key}`}
                        aria-current={active ? "page" : undefined}
                        className={`relative shrink-0 whitespace-nowrap rounded-lg px-3 py-1.5 text-[14px] font-semibold transition-colors ${
                          active ? "text-fg-strong" : "text-muted hover:bg-surface-2 hover:text-fg-strong"
                        }`}
                      >
                        {active ? (
                          <motion.span
                            layoutId="dashboard-tab-pill"
                            aria-hidden
                            className="absolute inset-0 rounded-lg bg-surface-3"
                            transition={{ type: "spring", stiffness: 380, damping: 32 }}
                          />
                        ) : null}
                        <span className="relative">{f.label}</span>
                      </Link>
                    );
                  })}
                </nav>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setSearchMode(true)}
                    aria-label="Search and filter listings"
                    className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-[14px] font-medium text-fg shadow-xs transition-colors hover:bg-surface-2 hover:text-fg-strong"
                  >
                    {/* Labeled, not icon-only: earns recognition and reads as the
                        list-scoped search+filter — distinct from the global ⌘K
                        "Search listings" in the top bar (Shopify labels it too). */}
                    <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="11" cy="11" r="8" />
                      <path d="m21 21-4.3-4.3" />
                    </svg>
                    Search &amp; filter
                  </button>
                  <SortMenu sort={sort} setSort={setSort} />
                </div>
              </motion.div>
            )}
            </AnimatePresence>
          </div>

          {/* Keyed by the active tab so switching views cross-fades the content
              in (smooth tab transitions, owner). The sliding underline above is
              a shared-layout motion element; this fades the rows beneath it. */}
          <motion.div
            key={filter}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2, ease: [0.21, 0.8, 0.32, 1] }}
          >
            {visible.length === 0 ? (
              filtersActive ? (
                <p className="px-4 py-12 text-center text-[15px] text-muted">
                  No listings match your search.{" "}
                  <button type="button" onClick={clearAllFilters} className="font-semibold text-accent-soft-fg hover:underline">
                    Clear all
                  </button>
                </p>
              ) : (
                <p className="px-4 py-12 text-center text-[15px] text-muted">
                  Nothing under “{activeFilter.label}” yet. Items move here as their status changes.
                </p>
              )
            ) : (
              <>
                {/* column headers (md+) + select-all. px matches a row's
                    effective inset (ul px-1 + row md:px-4 / lg:px-5) so columns
                    align. Product/Status/Price/Listed sort; Category/Condition
                    are plain labels (disclosed at lg/xl with their columns). */}
                <div className={`group/head hidden border-b border-border px-5 py-3 lg:px-6 ${ROW_GRID}`}>
                  <RowCheckbox checked={allSelected} onToggle={toggleAll} label="Select all listings" />
                  <SortHeader label="Product" k="title" sort={sort} onSort={onSortToggle} />
                  <SortHeader label="Status" k="status" sort={sort} onSort={onSortToggle} align="center" />
                  <span className="hidden text-center text-[12px] font-semibold uppercase tracking-[0.08em] text-muted xl:block">
                    Category
                  </span>
                  <span className="hidden text-center text-[12px] font-semibold uppercase tracking-[0.08em] text-muted xl:block">
                    Condition
                  </span>
                  <SortHeader label="Price" k="price" sort={sort} onSort={onSortToggle} align="center" />
                  {/* Listed discloses at lg with its column (ROW_GRID sync). */}
                  <span className="hidden lg:flex lg:justify-center">
                    <SortHeader label="Listed" k="date" sort={sort} onSort={onSortToggle} align="center" />
                  </span>
                </div>

                {/* Mobile select-all — below md the column header (which hosts
                    select-all on desktop) is hidden, so surface an equivalent
                    here for touch bulk-select parity. Tappable label + the same
                    44px RowCheckbox the rows use. */}
                <div className="flex items-center gap-3 border-b border-border px-3 py-2 md:hidden">
                  <RowCheckbox
                    checked={allSelected}
                    onToggle={toggleAll}
                    label={allSelected ? "Deselect all listings" : "Select all listings"}
                  />
                  <button
                    type="button"
                    onClick={toggleAll}
                    className="py-1 text-[13.5px] font-medium text-fg"
                  >
                    {selected.size > 0 ? (
                      <>
                        <span data-nums>{selected.size}</span> selected
                      </>
                    ) : (
                      <>
                        Select all <span className="text-muted" data-nums>({visible.length})</span>
                      </>
                    )}
                  </button>
                </div>

                <ul className="divide-y divide-border px-1 py-1">
                  {visible.map((row, i) => (
                    <li key={`${row.itemId}-${row.listingId ?? "item"}`} className="row-enter" style={{ animationDelay: enterDelay(i) }}>
                      <ListingRow row={row} selected={selected.has(row.itemId)} onToggle={() => toggleRow(row.itemId)} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </motion.div>
        </section>
      )}

      {/* ---- floating bulk action bar (Shopify bulk-edit) ---- */}
      {selected.size > 0 ? (
        // Center the bar over the MAIN content area, not the viewport: at sm+ the
        // sidebar occupies --sidebar-w on the left, so offset the fixed band's left
        // edge by it (mirrors the topbar's centered search). The live var means the
        // bar glides as the sidebar collapses/expands; mobile (no sidebar) stays
        // full-width centered via inset-x-0.
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-4 sm:bottom-8 sm:left-[var(--sidebar-w)]">
          <div className="pointer-events-auto flex max-w-[calc(100vw-1.5rem)] items-center gap-1 overflow-x-auto rounded-xl border border-border-strong bg-flash px-2 py-1.5 text-primary-fg shadow-lg [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
            <span className="px-2 text-[13px] font-medium text-primary-fg/90" data-nums>
              {selected.size} selected
            </span>
            <span aria-hidden className="mx-1 h-5 w-px bg-primary-fg/20" />
            {bulkUpdateAction ? (
              <button
                type="button"
                onClick={() => setQuickEdit(true)}
                className="rounded-lg px-3 py-1.5 text-[13.5px] font-semibold text-primary-fg/90 transition-colors hover:bg-primary-fg/10"
              >
                Quick edit
              </button>
            ) : null}
            {/* Inline actions are sm+ only; below sm they collapse into the
                "More" menu (audit #105: four text actions overflowed a 390px
                bar and hid Delete + Clear behind an invisible scroll). */}
            {archiveTargets.length > 0 ? (
              <button
                type="button"
                onClick={() => setConfirm("archive")}
                className="hidden rounded-lg px-3 py-1.5 text-[13.5px] font-semibold text-primary-fg/90 transition-colors hover:bg-primary-fg/10 sm:block"
              >
                Archive
              </button>
            ) : null}
            {unarchiveTargets.length > 0 ? (
              <button
                type="button"
                onClick={runUnarchive}
                disabled={isPending}
                className="hidden rounded-lg px-3 py-1.5 text-[13.5px] font-semibold text-primary-fg/90 transition-colors hover:bg-primary-fg/10 disabled:opacity-50 sm:block"
              >
                Unarchive
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setConfirm("delete")}
              className="hidden rounded-lg px-3 py-1.5 text-[13.5px] font-semibold text-danger-on-flash transition-colors hover:bg-primary-fg/10 sm:block"
            >
              Delete
            </button>
            <BulkMoreMenu
              canArchive={archiveTargets.length > 0}
              canUnarchive={unarchiveTargets.length > 0}
              pending={isPending}
              onArchive={() => setConfirm("archive")}
              onUnarchive={runUnarchive}
              onDelete={() => setConfirm("delete")}
            />
            <button
              type="button"
              onClick={clearSelection}
              aria-label="Clear selection"
              className="ml-0.5 flex size-9 items-center justify-center rounded-lg text-primary-fg/70 transition-colors hover:bg-primary-fg/10 hover:text-primary-fg sm:size-7"
            >
              <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      ) : null}

      {confirm === "archive" ? (
        <ConfirmDialog
          title={`Archive ${archiveTargets.length} listing${archiveTargets.length === 1 ? "" : "s"}?`}
          body="Archived listings are hidden from your working set. You'll find them anytime under the Archived tab, and can restore them later."
          confirmLabel="Archive"
          pending={isPending}
          onConfirm={runArchive}
          onCancel={() => setConfirm(null)}
        />
      ) : null}
      {confirm === "delete" ? (
        <ConfirmDialog
          title={`Delete ${deleteTargets.length} item${deleteTargets.length === 1 ? "" : "s"}?`}
          body="This permanently removes the item, its listing, and any buyer messages. This can't be undone."
          confirmLabel="Delete"
          danger
          pending={isPending}
          onConfirm={runDelete}
          onCancel={() => setConfirm(null)}
        />
      ) : null}

      {/* Confirmation toast. AnimatePresence keeps it mounted through the exit
          so it FADES out (not a hard cut) when the 3.2s timer clears it; keying
          on the message animates one toast out and the next in. Offset by the
          sidebar (like the bulk bar) so it centers over the content, not the
          full viewport. Reduced-motion users get a pure opacity crossfade. */}
      <AnimatePresence>
        {toast ? (
          <motion.div
            key={toast}
            initial={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: reduceMotion ? 0 : 10 }}
            transition={{ duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 sm:bottom-8 sm:left-[var(--sidebar-w)]"
          >
            <div className="pointer-events-auto rounded-lg bg-flash px-3.5 py-2 text-[13px] font-medium text-primary-fg shadow-lg" role="status">
              {toast}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      {quickEdit ? (
        <BulkEditGrid
          rows={selectedRows}
          pending={isPending}
          onClose={() => setQuickEdit(false)}
          onSave={runBulkUpdate}
        />
      ) : null}
    </main>
  );
}
