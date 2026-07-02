"use client";

import { useRef, useState } from "react";
import { parsePriceOverride } from "@/lib/pipeline/autopilot";
import { lifecycleLabel } from "@/lib/ui/status";
import { Select } from "@/components/ui/select";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { useEscapeToClose, useModalFocus } from "@/components/ui/overlay-behavior";
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

  // Classify an edited price exactly as the review form does (the shared,
  // unit-tested parsePriceOverride): blank → clear the override (null); a valid
  // positive amount → normalized cents; a stray "-"/"e"/"0x10", 0, or a negative
  // → INVALID. The old local parser coerced anything non-finite to null, which
  // silently CLEARED the seller's price on a typo and let 0/negative through as a
  // saved override the publish flow can't use (Codex P2). Invalid now blocks Save
  // and flags the field instead of coercing.
  type PriceState =
    | { kind: "clear" }
    | { kind: "value"; value: number }
    | { kind: "invalid" };
  const priceState = (s: string): PriceState => {
    if (s.trim() === "") return { kind: "clear" };
    try {
      const value = parsePriceOverride(s);
      return value == null ? { kind: "clear" } : { kind: "value", value };
    } catch {
      return { kind: "invalid" };
    }
  };

  const updates: BulkListingUpdate[] = rows.flatMap((r) => {
    const e = edits[r.itemId];
    if (!e) return [];
    const ps = priceState(e.price);
    if (ps.kind === "invalid") return []; // never persist an invalid price
    const newPrice = ps.kind === "clear" ? null : ps.value;
    const priceChanged = newPrice !== r.price;
    // Status only edits when the item has a listing AND isn't live on eBay — a
    // live (published) listing's status is owned by the eBay state, so bulk-edit
    // must not move it to draft/archived and mislabel it (Codex). The select is
    // disabled for those rows; this mirrors the rule in the change set.
    const statusChanged =
      !!r.listingId && r.status !== "published" && e.status !== r.status;
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
  // Block Save while ANY edited price is invalid — a typo must be corrected, not
  // silently dropped (the invalid row is excluded from `updates`, so without this
  // guard Save would quietly skip it).
  const hasInvalidPrice = rows.some(
    (r) => edits[r.itemId] && priceState(edits[r.itemId].price).kind === "invalid",
  );
  const dirty = updates.length > 0;

  // Closing a dirty session (Escape, Back, Discard) confirms before dropping
  // the pending edits — Escape is too easy to hit to silently lose a long
  // editing pass. A clean session closes instantly. The confirm mounts after
  // this dialog, so it registers ABOVE it on the escape stack: Escape in the
  // confirm closes only the confirm.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const requestClose = () => {
    if (dirty || hasInvalidPrice) setConfirmingDiscard(true);
    else onClose();
  };

  const dialogRef = useRef<HTMLDivElement>(null);
  useEscapeToClose(true, requestClose);
  useModalFocus(true, dialogRef);

  // Mobile: a single column — product stacks above a 2-up Status/Price sub-grid
  // (the sub-grid dissolves via `sm:contents` so the two controls become direct
  // grid children at sm). sm+: the dense 3-column editor table. minmax(0,1fr)
  // lets a long title truncate instead of overflowing.
  const GRID =
    "grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_160px_130px] sm:items-center sm:gap-5";

  return (
    // A full-screen editor IS a modal (audit #105): announce it as one, move
    // focus into it (Back button, via data-autofocus), trap Tab, close on
    // Escape (the Select's own Escape preventDefaults, so closing an open
    // dropdown doesn't also discard the editor), restore focus on exit.
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Bulk edit ${rows.length} ${rows.length === 1 ? "listing" : "listings"}`}
      className="fixed inset-0 z-[60] flex flex-col bg-bg"
    >
      {/* header — Shopify's "← Back · Editing N · Discard · Save" bar */}
      <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-surface px-4 sm:px-6">
        <button
          type="button"
          data-autofocus
          onClick={requestClose}
          aria-label="Back to listings"
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted shadow-xs transition-colors hover:bg-surface-2 hover:text-fg-strong"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <div className="flex min-w-0 items-center gap-2.5">
          <h1 className="font-display text-[16px] font-semibold leading-none tracking-tight text-fg-strong">
            Bulk edit
          </h1>
          <span
            className="rounded-full bg-surface-2 px-2 py-0.5 text-[12px] font-medium text-muted"
            data-nums
          >
            {rows.length} {rows.length === 1 ? "listing" : "listings"}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={requestClose}
            className="rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg-strong"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={() => onSave(updates)}
            disabled={!dirty || pending || hasInvalidPrice}
            title={hasInvalidPrice ? "Fix the highlighted price before saving" : undefined}
            className="rounded-lg bg-primary px-4 py-2 text-[14px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-start px-4 py-6 sm:justify-center sm:py-8 sm:px-6">
          <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-xs">
            {/* column headers — a real table head; hidden on mobile where the
                stacked rows carry their own inline captions */}
            <div className={`${GRID} hidden border-b border-border bg-surface-2 px-4 py-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted sm:grid`}>
              <span>Product</span>
              <span className="text-center">Status</span>
              <span className="text-center">Price</span>
            </div>

            <ul className="divide-y divide-border">
            {rows.map((r) => {
              const e = edits[r.itemId];
              const noListing = !r.listingId;
              // A live (published) listing's status is owned by the eBay state —
              // bulk-edit must not move it to draft/archived (Codex), so its select
              // is read-only here.
              const isLive = r.status === "published";
              const priceInvalid = !!e && priceState(e.price).kind === "invalid";
              return (
                <li key={r.itemId} className={`${GRID} px-4 py-4 transition-colors hover:bg-surface-2 focus-within:bg-surface-2 sm:py-3.5`}>
                  {/* Product (read-only) */}
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-border bg-surface-2">
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
                    <span className="truncate text-[15px] font-semibold leading-tight text-fg-strong">{r.title}</span>
                  </span>

                  {/* Status + Price — a 2-up sub-grid on mobile; `sm:contents`
                      dissolves it at sm so both controls land in the table's
                      Status/Price columns. */}
                  <div className="grid grid-cols-2 gap-3 sm:contents">
                    {/* Status (editable when the item has a listing). A current
                        status that isn't bulk-settable is prepended as a
                        display-only option so the row shows its REAL state and can
                        be left unchanged; a live row disables the control. */}
                    <div className="min-w-0">
                      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.04em] text-muted sm:hidden">
                        Status
                      </span>
                      <Select
                        value={e?.status ?? r.status}
                        onChange={(v) => setField(r.itemId, "status", v)}
                        disabled={noListing || isLive}
                        title={isLive ? "Live eBay listings are managed from the listing, not bulk-edit" : undefined}
                        aria-label={`Status for ${r.title}`}
                        options={[
                          ...(!STATUS_OPTIONS.some((o) => o.value === r.status)
                            ? [{ value: r.status, label: lifecycleLabel(r.status)?.label ?? r.status }]
                            : []),
                          ...STATUS_OPTIONS,
                        ]}
                        className="w-full bg-surface px-2.5 py-2 text-[14px] font-medium text-fg"
                      />
                    </div>

                    {/* Price → item.price_override. An invalid entry rings red and
                        blocks Save (instead of silently clearing the override). */}
                    <div className="min-w-0">
                      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.04em] text-muted sm:hidden">
                        Price
                      </span>
                      <div
                        className={`flex items-center rounded-lg border bg-surface pl-2.5 transition-colors ${
                          priceInvalid
                            ? "border-danger ring-2 ring-danger/25"
                            : "border-border-strong focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25"
                        }`}
                      >
                        <span className="text-[15px] font-medium text-muted">$</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          inputMode="decimal"
                          value={e?.price ?? ""}
                          onChange={(ev) => setField(r.itemId, "price", ev.target.value)}
                          placeholder="—"
                          aria-label={`Price for ${r.title}`}
                          aria-invalid={priceInvalid}
                          className="w-full bg-transparent px-1.5 py-1.5 text-right text-[16px] font-semibold tracking-tight text-fg-strong outline-none"
                          data-nums
                        />
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
            </ul>
          </div>
        </div>
      </div>

      {confirmingDiscard ? (
        <ConfirmDialog
          title="Discard unsaved edits?"
          body="Your pending changes to these listings will be lost."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          danger
          pending={false}
          onConfirm={onClose}
          onCancel={() => setConfirmingDiscard(false)}
        />
      ) : null}
    </div>
  );
}
