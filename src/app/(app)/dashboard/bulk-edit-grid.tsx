"use client";

import { useState } from "react";
import { lifecycleLabel } from "@/lib/ui/status";
import type { DashboardRow } from "./dashboard-view";
import type { BulkListingUpdate } from "./actions";

/**
 * Bulk quick-edit grid — Shopify's "Editing N products" full-screen table,
 * repurposed for SnapList (we sell single used items, so there's no stock to
 * edit). It edits the two fields that DO bulk-edit cleanly: Status (→ the
 * listing) and Price (→ the item's price_override). Same dense, inline-editable
 * affordance as Shopify's inventory table; one batched save.
 *
 * Self-contained: local edit state initialised from the selected rows; Save
 * sends only the rows that actually changed; Discard closes without writing.
 */

// Only seller-organizational statuses are bulk-settable — see BULK_EDITABLE_STATUSES
// in @/lib/ui/status. "Live" (published) is owned by the eBay publish path and
// "Scheduled" (queued) by the autopilot gate, so neither is offered here: a bulk
// metadata edit must never mark an unposted item live or queue it past the gate
// (Codex P1). A row already in one of those states still renders its real status
// via the fallback <option> below; it just can't be SET from the grid.
const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: "draft", label: "Needs review" },
  { value: "archived", label: "Archived" },
];

interface RowEdit {
  price: string;
  status: string;
}

export function BulkEditGrid({
  rows,
  onSave,
  onClose,
  pending,
}: {
  rows: DashboardRow[];
  onSave: (updates: BulkListingUpdate[]) => void;
  onClose: () => void;
  pending: boolean;
}) {
  const [edits, setEdits] = useState<Record<string, RowEdit>>(() =>
    Object.fromEntries(
      rows.map((r) => [
        r.itemId,
        { price: r.price != null ? String(r.price) : "", status: r.status },
      ]),
    ),
  );

  const setField = (itemId: string, field: keyof RowEdit, value: string) =>
    setEdits((prev) => ({ ...prev, [itemId]: { ...prev[itemId], [field]: value } }));

  const parsedPrice = (s: string): number | null => {
    const t = s.trim();
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  };

  const updates: BulkListingUpdate[] = rows.flatMap((r) => {
    const e = edits[r.itemId];
    if (!e) return [];
    const newPrice = parsedPrice(e.price);
    const priceChanged = newPrice !== r.price;
    // Status only edits when the item actually has a listing to carry it.
    const statusChanged = !!r.listingId && e.status !== r.status;
    if (!priceChanged && !statusChanged) return [];
    return [
      {
        itemId: r.itemId,
        listingId: r.listingId,
        ...(priceChanged ? { price: newPrice } : {}),
        ...(statusChanged ? { status: e.status } : {}),
      },
    ];
  });
  const dirty = updates.length > 0;

  const GRID = "grid grid-cols-[1fr_150px_120px] items-center gap-4";

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-bg">
      {/* header — Shopify's "← Back · Editing N · Discard · Save" bar */}
      <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to listings"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted shadow-xs transition-colors hover:bg-surface-2 hover:text-fg-strong"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <h1 className="text-[15px] font-bold tracking-tight text-fg-strong" data-nums>
          Editing {rows.length} listing{rows.length === 1 ? "" : "s"}
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-[14px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => onSave(updates)}
            disabled={!dirty || pending}
            className="rounded-lg bg-primary px-3.5 py-1.5 text-[14px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-5 sm:px-6">
          {/* column headers */}
          <div className={`${GRID} border-b border-border px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-faint`}>
            <span>Product</span>
            <span>Status</span>
            <span className="text-right">Price</span>
          </div>

          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const e = edits[r.itemId];
              const noListing = !r.listingId;
              return (
                <li key={r.itemId} className={`${GRID} px-3 py-2.5`}>
                  {/* Product (read-only) */}
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="relative size-10 shrink-0 overflow-hidden rounded-lg border border-border bg-surface-2">
                      {r.thumbUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL
                        <img src={r.thumbUrl} alt="" aria-hidden className="size-full object-cover" />
                      ) : (
                        <span aria-hidden className="flex size-full items-center justify-center text-faint">
                          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <circle cx="9" cy="9" r="2" />
                            <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
                          </svg>
                        </span>
                      )}
                    </span>
                    <span className="truncate text-[14px] font-medium text-fg-strong">{r.title}</span>
                  </span>

                  {/* Status (editable when the item has a listing) */}
                  <select
                    value={e?.status ?? r.status}
                    disabled={noListing}
                    onChange={(ev) => setField(r.itemId, "status", ev.target.value)}
                    aria-label={`Status for ${r.title}`}
                    className="w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-[14px] text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-faint"
                  >
                    {/* A current status that isn't bulk-settable (Active, Scheduled,
                        Processing, …) stays selectable so the row shows its REAL
                        state and can be left unchanged — honestly labeled, never the
                        raw key. The seller can only switch it to a bulk-editable option. */}
                    {!STATUS_OPTIONS.some((o) => o.value === r.status) ? (
                      <option value={r.status}>
                        {lifecycleLabel(r.status)?.label ?? r.status}
                      </option>
                    ) : null}
                    {STATUS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>

                  {/* Price → item.price_override */}
                  <div className="flex items-center rounded-lg border border-border-strong bg-surface pl-2.5 transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
                    <span className="text-[14px] text-faint">$</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      inputMode="decimal"
                      value={e?.price ?? ""}
                      onChange={(ev) => setField(r.itemId, "price", ev.target.value)}
                      placeholder="—"
                      aria-label={`Price for ${r.title}`}
                      className="w-full bg-transparent px-1.5 py-1.5 text-right text-[14px] font-semibold text-fg-strong outline-none"
                      data-nums
                    />
                  </div>
                </li>
              );
            })}
          </ul>

          <p className="mt-4 px-3 text-[13px] text-faint">
            Editing {rows.length} selected listing{rows.length === 1 ? "" : "s"}. Price
            updates the seller price; status moves the listing through its
            lifecycle. Items still processing (no listing yet) accept a price only.
          </p>
        </div>
      </div>
    </div>
  );
}
