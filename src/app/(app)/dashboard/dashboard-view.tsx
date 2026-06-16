"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import CountUp from "@/components/bits/CountUp";
import Folder from "@/components/bits/Folder";
import { DEMO_PRODUCTS_BY_SLUG, type DemoProduct } from "@/lib/demo-products";
import { StatusBadge } from "@/components/ui/badge";
import { lifecycleShortLabel } from "@/lib/ui/status";
import { matchesQuery } from "@/lib/ui/search";
import { DASHBOARD_FILTERS, type DashboardFilterKey } from "./filters";
import type { BulkListingUpdate } from "./actions";

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
  thumbUrl: string | null;
}

export interface DashboardCounts {
  draft: number;
  attention: number;
  live: number;
}

type IdsAction = (ids: string[]) => Promise<void>;

const PRICE_FMT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

/** States the SELLER must act on — header summary + action-first ordering. */
const REVIEW_STATUSES = new Set(["draft", "draft_failed", "failed"]);

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
      className={`flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        checked
          ? "border-accent-solid bg-accent-solid text-accent-fg"
          : "border-border-strong bg-surface hover:border-fg-strong"
      }`}
    >
      {checked ? <CheckIcon className="size-3" /> : null}
    </button>
  );
}

/** Shared desktop column template (header + rows align): select · Product ·
 *  Status · Price · Listed. */
const ROW_GRID =
  "sm:grid sm:grid-cols-[auto_1fr_148px_104px_92px] sm:items-center sm:gap-4";

/**
 * One listing row. The whole row links to review (the inner <a> is
 * `display:contents`, so its children are the grid cells and a click anywhere
 * navigates), while the leading checkbox sits outside the link. Mobile: a
 * two-line card (checkbox · thumb+title+meta · price); sm+: the table columns.
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
      className={`group/row grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-lg px-2.5 py-2.5 transition-colors hover:bg-surface-2 sm:px-3 ${ROW_GRID} ${
        selected ? "bg-accent-soft/50" : ""
      }`}
    >
      <RowCheckbox checked={selected} onToggle={onToggle} label={`Select ${row.title}`} />

      <Link href={`/review/${row.itemId}`} className="contents">
        {/* Product cell: cover thumbnail + title (+ mobile-only meta line). */}
        <span className="flex min-w-0 items-center gap-3">
          <span className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-border bg-surface-2">
            {row.thumbUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URL
              <img
                src={row.thumbUrl}
                alt=""
                aria-hidden
                className="size-full object-cover transition-transform duration-300 ease-out group-hover/row:scale-[1.05]"
              />
            ) : (
              <PhotoPlaceholder />
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[14px] font-semibold leading-snug text-fg-strong group-hover/row:underline">
              {row.title}
            </span>
            <span className="mt-1 flex items-center gap-2 sm:hidden">
              {chip ? <StatusBadge label={chip.label} tone={chip.tone} dot /> : null}
              <span className="text-[12px] text-faint" data-nums>
                {listedLabel(row.createdAt)}
              </span>
            </span>
          </span>
        </span>

        {/* Mobile-only price (right of the row). */}
        <span className="shrink-0 text-[15px] font-bold text-fg-strong sm:hidden" data-nums>
          {row.price != null ? (
            PRICE_FMT.format(row.price)
          ) : (
            <span className="text-[12px] font-normal text-faint">No price</span>
          )}
        </span>

        {/* Desktop columns. */}
        <span className="hidden sm:flex">
          {chip ? <StatusBadge label={chip.label} tone={chip.tone} dot /> : null}
        </span>
        <span className="hidden text-right text-[14px] font-bold text-fg-strong sm:block" data-nums>
          {row.price != null ? (
            PRICE_FMT.format(row.price)
          ) : (
            <span className="text-[13px] font-normal text-faint">—</span>
          )}
        </span>
        <span className="hidden text-right text-[13px] text-muted sm:block" data-nums>
          {listedLabel(row.createdAt)}
        </span>
      </Link>
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

/** Shopify-style "Sort" popover — sets the same SortState as the headers. */
function SortMenu({
  sort,
  setSort,
}: {
  sort: SortState;
  setSort: (s: SortState) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeLabel =
    SORT_OPTIONS.find((o) => o.key === sort.key)?.label ?? "Sort";
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[13px] font-medium text-muted shadow-xs transition-colors hover:bg-surface-2 hover:text-fg-strong"
      >
        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 6h13M3 12h9M3 18h5M17 9l4 4 4-4" transform="translate(-4 0)" />
        </svg>
        <span className="hidden sm:inline">{sort.key === "smart" ? "Sort" : activeLabel}</span>
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
            role="menu"
            className="absolute right-0 z-50 mt-1 w-56 rounded-xl border border-border bg-surface p-1.5 shadow-lg"
          >
            <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint">
              Sort by
            </p>
            {SORT_OPTIONS.map((o) => (
              <button
                key={o.key}
                type="button"
                role="menuitemradio"
                aria-checked={sort.key === o.key}
                onClick={() => setSort({ key: o.key, dir: DEFAULT_DIR[o.key] })}
                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors hover:bg-surface-2 ${
                  sort.key === o.key ? "font-semibold text-accent-soft-fg" : "text-fg"
                }`}
              >
                {o.label}
                {sort.key === o.key ? <CheckIcon className="size-3.5 text-accent-soft-fg" /> : null}
              </button>
            ))}
            <div className="my-1 border-t border-border" />
            {(["asc", "desc"] as const).map((dir) => (
              <button
                key={dir}
                type="button"
                role="menuitemradio"
                aria-checked={sort.dir === dir}
                onClick={() => setSort({ key: sort.key === "smart" ? "date" : sort.key, dir })}
                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors hover:bg-surface-2 ${
                  sort.dir === dir ? "font-semibold text-accent-soft-fg" : "text-fg"
                }`}
              >
                {dir === "asc" ? "Lowest to highest" : "Highest to lowest"}
                {sort.dir === dir ? <CheckIcon className="size-3.5 text-accent-soft-fg" /> : null}
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

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-faint">
      <span aria-hidden className="h-[2px] w-6 rounded-full bg-accent" />
      {children}
    </span>
  );
}

/** Confirm dialog for archive / delete (mirrors Shopify's "Archive N?" modal). */
function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  pending,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(26,26,26,0.4)] p-4 backdrop-blur-[2px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-2xl"
      >
        <h2 className="text-[16px] font-bold tracking-tight text-fg-strong">{title}</h2>
        <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-border-strong bg-surface px-3.5 py-2 text-[14px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className={`rounded-lg px-3.5 py-2 text-[14px] font-semibold shadow-xs transition-colors disabled:opacity-50 ${
              danger
                ? "bg-danger text-white hover:bg-danger-solid"
                : "bg-primary text-primary-fg hover:bg-primary-hover"
            }`}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// `counts` stays in the props API for the page/preview callers, but the tab
// counts are computed from `rows` directly.
export function DashboardView({
  rows,
  filter,
  archiveAction,
  unarchiveAction,
  deleteAction,
}: {
  rows: DashboardRow[];
  counts: DashboardCounts;
  filter: DashboardFilterKey;
  archiveAction?: IdsAction;
  unarchiveAction?: IdsAction;
  deleteAction?: IdsAction;
  /** Reserved for the Phase-4 quick-edit grid. */
  bulkUpdateAction?: (updates: BulkListingUpdate[]) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState>({ key: "smart", dir: "asc" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

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

  const enterDelay = (i: number) => `${Math.min(i, 12) * 24}ms`;

  const totalValue = rows.reduce((sum, r) => sum + (r.price ?? 0), 0);
  const reviewCount = rows.filter((r) => REVIEW_STATUSES.has(r.status)).length;
  const liveCount = rows.filter((r) => r.status === "published").length;

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
  const archiveTargets = selectedRows
    .filter((r) => r.listingId && r.status !== "archived")
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

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 pb-12 pt-8 sm:px-6 sm:pt-10">
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
          {/* ---- toolbar: tab strip + sort + inline search ---- */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border px-2 sm:px-3">
            <nav aria-label="Filter by status" className="-mx-1 flex gap-1 overflow-x-auto [scrollbar-width:none]">
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
                    <span className={`text-[12.5px] ${active ? "text-accent-soft-fg" : "text-faint"}`} data-nums>
                      <CountUp to={filterCount(f)} duration={0.7} />
                    </span>
                    {active ? (
                      <span aria-hidden className="absolute inset-x-3 -bottom-px h-[2px] rounded-full bg-accent" />
                    ) : null}
                  </Link>
                );
              })}
            </nav>
            <div className="mb-2 flex w-full items-center gap-2 sm:mb-1.5 sm:w-auto">
              <label className="flex flex-1 items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5 text-[14px] focus-within:ring-2 focus-within:ring-accent/40 sm:w-56 sm:flex-none">
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
              <SortMenu sort={sort} setSort={setSort} />
            </div>
          </div>

          {visible.length === 0 ? (
            searching ? (
              <p className="px-4 py-12 text-center text-[15px] text-muted">
                No titles match “{query.trim()}”.{" "}
                <button type="button" onClick={() => setQuery("")} className="font-semibold text-accent-soft-fg hover:underline">
                  Clear
                </button>
              </p>
            ) : (
              <p className="px-4 py-12 text-center text-[15px] text-muted">
                Nothing under “{activeFilter.label}” yet. Items move here as their status changes.
              </p>
            )
          ) : (
            <>
              {/* sortable column headers (desktop) + select-all */}
              <div className={`group/head hidden border-b border-border px-3 py-2 ${ROW_GRID}`}>
                <RowCheckbox checked={allSelected} onToggle={toggleAll} label="Select all listings" />
                <SortHeader label="Product" k="title" sort={sort} onSort={onSortToggle} />
                <SortHeader label="Status" k="status" sort={sort} onSort={onSortToggle} />
                <SortHeader label="Price" k="price" sort={sort} onSort={onSortToggle} align="right" />
                <SortHeader label="Listed" k="date" sort={sort} onSort={onSortToggle} align="right" />
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
        </section>
      )}

      {/* ---- floating bulk action bar (Shopify bulk-edit) ---- */}
      {selected.size > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center px-4 sm:bottom-8">
          <div className="pointer-events-auto flex items-center gap-1 rounded-xl border border-border-strong bg-flash px-2 py-1.5 text-primary-fg shadow-lg">
            <span className="px-2 text-[13px] font-medium text-primary-fg/90" data-nums>
              {selected.size} selected
            </span>
            <span aria-hidden className="mx-1 h-5 w-px bg-primary-fg/20" />
            {archiveTargets.length > 0 ? (
              <button
                type="button"
                onClick={() => setConfirm("archive")}
                className="rounded-lg px-3 py-1.5 text-[13.5px] font-semibold text-primary-fg/90 transition-colors hover:bg-primary-fg/10"
              >
                Archive
              </button>
            ) : null}
            {unarchiveTargets.length > 0 ? (
              <button
                type="button"
                onClick={runUnarchive}
                disabled={isPending}
                className="rounded-lg px-3 py-1.5 text-[13.5px] font-semibold text-primary-fg/90 transition-colors hover:bg-primary-fg/10 disabled:opacity-50"
              >
                Unarchive
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setConfirm("delete")}
              className="rounded-lg px-3 py-1.5 text-[13.5px] font-semibold text-[#ff9b91] transition-colors hover:bg-primary-fg/10"
            >
              Delete
            </button>
            <button
              type="button"
              onClick={clearSelection}
              aria-label="Clear selection"
              className="ml-0.5 flex size-7 items-center justify-center rounded-lg text-primary-fg/70 transition-colors hover:bg-primary-fg/10 hover:text-primary-fg"
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

      {toast ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 sm:bottom-8">
          <div className="pointer-events-auto rounded-lg bg-flash px-3.5 py-2 text-[13px] font-medium text-primary-fg shadow-lg" role="status">
            {toast}
          </div>
        </div>
      ) : null}
    </main>
  );
}
