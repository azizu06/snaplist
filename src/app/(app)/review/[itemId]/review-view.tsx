"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { PhotoCarousel } from "@/components/ui/photo-carousel";
import SpotlightCard from "@/components/bits/SpotlightCard";
import { StatusBadge } from "@/components/ui/badge";
import { ConfidenceGauge } from "@/components/ui/confidence-gauge";
import { Banner, type BannerVariant } from "@/components/ui/banner";
import { PendingButton } from "@/components/ui/button";
import { EBAY_TITLE_MAX } from "@/lib/pipeline/review-edits";
import {
  confidenceLabel,
  lifecycleLabel,
  tierLabel,
} from "@/lib/ui/status";

/**
 * Review — "the item is the hero" rework (ui-lifecycle-revamp, round 2). Owner
 * feedback drove a real restructure for cohesion + balance + mobile:
 *  - ONE accent (brand violet). The green "Identified" chip is gone; status is
 *    said once (the banner), confidence once (the gauge), and the five purple
 *    "AI-suggested" pills are demoted to a single faint sparkle on each field.
 *  - The top bar is decluttered: title gets its own line on mobile, actions
 *    drop to a second row; no redundant header status chip.
 *  - The photo uses the SAME swipeable PhotoCarousel as the upload sheet, now
 *    tap-to-zoom in the hero.
 *  - Facts live in ONE place: identity name in the hero, every attribute
 *    (brand/model/category/condition/upc/isbn) only in Item details — no
 *    duplicate spec pills. Price + the pricing intelligence live together in
 *    the hero command column.
 *  - Layout is a full-width hero then full-width stacked cards (Your listing →
 *    Item details), so there's no short/tall column mismatch; everything
 *    collapses cleanly to one column on mobile.
 *
 * Client component, pure presentation over serializable props + the action.
 */

export interface ReviewData {
  itemId: string;
  photoUrls: string[];
  identification: {
    label: string;
    confident: boolean;
    reason: string | null;
    candidates: string[];
    evidence: number;
  } | null;
  attrs: Array<{ key: string; value: string | null }>;
  listing: {
    id: string;
    platform: string;
    title: string;
    description: string;
    status: string | null;
  } | null;
  suggested: number | null;
  override: number | null;
  displayPrice: number | null;
  range: { low?: number; high?: number } | null;
  confidence: number | null;
  tier: string | null;
  banner: { variant: BannerVariant; title: string; detail: string } | null;
  actionError: string | null;
}

/** App-card chrome for the react-bits SpotlightCard (vs its marketing default). */
const APP_CARD_CHROME = "rounded-2xl border border-border bg-surface shadow-xs";

const INPUT_CLASSES =
  "w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-[15px] text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20";

const READONLY_FIELD =
  "rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-[14px] text-fg break-words";

/** Human labels for read-only attribute keys that aren't plain words — acronyms
 *  must render UPPERCASE (not "Upc"/"Isbn"). Other keys fall back to capitalize. */
const ATTR_LABELS: Record<string, string> = { upc: "UPC", isbn: "ISBN" };

type FieldKey = "title" | "description" | "category" | "condition" | "price";

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M12 2.5c.3 0 .57.2.66.49l1.4 4.6a3 3 0 0 0 1.99 1.99l4.6 1.4a.69.69 0 0 1 0 1.32l-4.6 1.4a3 3 0 0 0-1.99 1.99l-1.4 4.6a.69.69 0 0 1-1.32 0l-1.4-4.6a3 3 0 0 0-1.99-1.99l-4.6-1.4a.69.69 0 0 1 0-1.32l4.6-1.4a3 3 0 0 0 1.99-1.99l1.4-4.6c.09-.29.36-.49.66-.49Z" />
    </svg>
  );
}

/**
 * Provenance affordance, demoted from a filled pill to a single faint violet
 * sparkle (owner: too many competing colors). Marks a field still showing the
 * pipeline's suggestion; vanishes on first edit. The field was never locked.
 */
function AiSparkle({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span title="Suggested by SnapList; edit freely" className="text-accent/70">
      <SparkleIcon className="size-3" />
    </span>
  );
}

/** Dash-accented small-caps section eyebrow — the shared lifecycle label. */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-faint">
      <span aria-hidden className="h-[2px] w-6 rounded-full bg-accent" />
      {children}
    </span>
  );
}

function FieldLabel({
  label,
  htmlFor,
  ai,
  aside,
}: {
  label: string;
  htmlFor: string;
  ai: boolean;
  aside?: React.ReactNode;
}) {
  return (
    <span className="mb-1 flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5">
        <label htmlFor={htmlFor} className="text-[14px] font-medium text-fg">
          {label}
        </label>
        <AiSparkle visible={ai} />
      </span>
      {aside}
    </span>
  );
}

/** Visual price range — the landing page's PriceFrame treatment: a gradient
 *  track with the suggested price as a marker, low/high endpoints labeled. */
function RangeBar({
  low,
  high,
  suggested,
}: {
  low: number | null | undefined;
  high: number | null | undefined;
  suggested: number | null;
}) {
  if (low == null || high == null || high <= low) return null;
  const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
  const at = suggested != null ? clamp01((suggested - low) / (high - low)) : null;
  return (
    <div>
      <div className="relative h-1.5 rounded-full bg-surface-3">
        <span className="absolute inset-y-0 left-[6%] right-[6%] rounded-full bg-gradient-to-r from-[#7a73ff] via-[#635bff] to-[#a960ee] opacity-70" />
        {at != null ? (
          <span
            aria-hidden
            className="absolute top-1/2 size-[13px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-surface bg-accent shadow-[0_0_0_3px_rgba(109,74,255,0.22)]"
            style={{ left: `${6 + at * 88}%` }}
          />
        ) : null}
      </div>
      <div className="mt-1.5 flex justify-between text-[12px] font-medium text-faint" data-nums>
        <span>${low}</span>
        <span>${high}</span>
      </div>
    </div>
  );
}

/**
 * "Sharpen the estimate" (clarify-variant) — shown only when confidence isn't high.
 * The seller adds a discriminating detail the photo couldn't show (exact GPU,
 * storage, year…); each becomes a `spec` the re-price action narrows the comp search
 * with. Its OWN form (posts to `sharpenAction`) — kept OUT of the save form so the
 * two never nest. Generic for any item: nothing here is product-specific.
 */
function SharpenCard({
  itemId,
  bandWord,
  candidates,
  action,
}: {
  itemId: string;
  bandWord: string | null;
  candidates: string[];
  action: (formData: FormData) => Promise<void>;
}) {
  const [chips, setChips] = useState<string[]>([]);
  const [input, setInput] = useState("");

  const addChip = (raw: string) => {
    const value = raw.trim();
    if (!value) return;
    setChips((prev) =>
      prev.some((c) => c.toLowerCase() === value.toLowerCase()) ? prev : [...prev, value],
    );
    setInput("");
  };
  const removeChip = (idx: number) =>
    setChips((prev) => prev.filter((_, i) => i !== idx));

  // Quick-add the model's own alternative guesses, minus ones already added.
  const suggestions = candidates.filter(
    (c) => !chips.some((chip) => chip.toLowerCase() === c.toLowerCase()),
  );

  return (
    <SpotlightCard
      chromeClassName={APP_CARD_CHROME}
      spotlightColor="rgba(109, 74, 255, 0.07)"
      className="p-4 sm:p-5"
    >
      <form action={action}>
        <input type="hidden" name="itemId" value={itemId} />
        {chips.map((c, i) => (
          <input key={`spec-${i}`} type="hidden" name="spec" value={c} />
        ))}

        <Eyebrow>Sharpen the estimate</Eyebrow>
        <p className="mt-3 max-w-prose text-[14.5px] leading-relaxed text-muted">
          Confidence is {bandWord ? bandWord.toLowerCase() : "limited"} because the photo
          can’t show everything that sets the price. Add a detail we couldn’t see — the
          exact model, GPU, storage, or year — and we’ll re-research the comps.
        </p>

        <div className="mt-4">
          <label htmlFor="sharpen-detail" className="mb-1.5 block text-[14px] font-medium text-fg">
            Add a detail
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="sharpen-detail"
              type="text"
              name="detail"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addChip(input);
                }
              }}
              placeholder="e.g. RTX 3060, 512GB SSD, 2021"
              className={`${INPUT_CLASSES} sm:flex-1`}
            />
            <button
              type="button"
              onClick={() => addChip(input)}
              disabled={input.trim().length === 0}
              className="shrink-0 rounded-lg border border-border-strong bg-surface px-4 py-2 text-[14px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Add detail
            </button>
          </div>

          {chips.length > 0 ? (
            <ul className="mt-3 flex flex-wrap gap-2">
              {chips.map((c, i) => (
                <li
                  key={`chip-${i}`}
                  className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/[0.06] py-1 pl-3 pr-1.5 text-[13px] font-medium text-fg"
                >
                  {c}
                  <button
                    type="button"
                    onClick={() => removeChip(i)}
                    aria-label={`Remove ${c}`}
                    className="grid size-4 place-items-center rounded-full text-[15px] leading-none text-faint transition-colors hover:bg-accent/15 hover:text-fg"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {suggestions.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-faint">Suggestions:</span>
              {suggestions.map((s, i) => (
                <button
                  key={`sugg-${i}`}
                  type="button"
                  onClick={() => addChip(s)}
                  className="rounded-full border border-border bg-surface px-3 py-1 text-[13px] text-muted transition-colors hover:border-accent/50 hover:text-fg"
                >
                  + {s}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] leading-relaxed text-faint">
            Re-researches live comps — one search. Your own price edits are kept.
          </p>
          <PendingButton pendingLabel="Re-pricing…" className="w-full sm:w-auto sm:shrink-0">
            Re-price
          </PendingButton>
        </div>
      </form>
    </SpotlightCard>
  );
}

export function ReviewView({
  data,
  saveAction,
  sharpenAction,
}: {
  data: ReviewData;
  saveAction: (formData: FormData) => Promise<void>;
  sharpenAction: (formData: FormData) => Promise<void>;
}) {
  const attr = (key: string) =>
    data.attrs.find((a) => a.key === key)?.value ?? "";

  const initial = useMemo(
    () => ({
      title: data.listing?.title ?? "",
      description: data.listing?.description ?? "",
      category: attr("category"),
      condition: attr("condition"),
      price: data.displayPrice != null ? String(data.displayPrice) : "",
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- derived purely from the serializable prop
    [data],
  );

  const [fields, setFields] = useState(initial);
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [photoIdx, setPhotoIdx] = useState(0);

  const setField = (key: FieldKey, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
    setTouched((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  };
  const discard = () => {
    setFields(initial);
    setTouched({});
  };

  const dirty = (Object.keys(initial) as FieldKey[]).some(
    (key) => fields[key] !== initial[key],
  );

  // "Still the AI's value" per field: untouched AND the suggestion existed.
  const ai = (key: FieldKey) =>
    !touched[key] &&
    initial[key] !== "" &&
    (key !== "price" ? true : data.override == null && data.suggested != null);

  const statusChip = lifecycleLabel(data.listing?.status ?? null);
  const confidenceChip = confidenceLabel(data.confidence);
  const tier = tierLabel(data.tier);
  // Confidence is shown ONCE (the gauge carries the number); strip any "(NN%)"
  // from the label so we never print "Low confidence 35%" beside a 35% gauge.
  const confidenceWord = confidenceChip
    ? confidenceChip.label.replace(/\s*\(\d+%\)\s*/, "").trim()
    : null;

  const readOnlyAttrs = data.attrs.filter(
    (a) =>
      a.key !== "category" &&
      a.key !== "condition" &&
      // UPC/ISBN are specialized barcodes — only surface them when actually
      // detected, so items without one (e.g. a laptop) don't show confusing
      // empty "Not detected" identifier rows. Brand/model always show.
      !(["upc", "isbn"].includes(a.key) && !a.value),
  );

  const heroLabel = data.identification?.label || fields.title || "Untitled item";
  // Header carries a SHORT, stable identity (brand + model) — NOT the long,
  // keyword-stuffed eBay title, which got ellipsized and looked unclean. The
  // full descriptive name still lives in the hero h2; the SEO title stays in
  // the editable Title field below.
  const shortName =
    [attr("brand"), attr("model")].filter(Boolean).join(" ").trim() ||
    data.identification?.label ||
    "Review listing";
  const uncertain =
    data.identification != null && !data.identification.confident;

  // Offer the clarify-variant re-price whenever confidence isn't already high (the
  // HIGH band starts at 0.75) and there's a priced suggestion to sharpen. Pure UI
  // gate; the action re-validates and re-prices server-side.
  const canSharpen =
    data.suggested != null && data.confidence != null && data.confidence < 0.75;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {/* ---- header: title on its own line; actions drop below (mobile-first) ---- */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/dashboard"
            aria-label="Back to listings"
            className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted shadow-xs transition-colors hover:text-fg sm:size-9"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </Link>
          <h1 className="min-w-0 flex-1 truncate font-display text-[20px] font-bold tracking-tight text-fg-strong sm:text-[22px]">
            {shortName}
          </h1>
        </div>
        <div className="flex items-center gap-2 sm:ml-auto sm:shrink-0">
          <Link
            href={`/export/${data.itemId}`}
            className="inline-flex flex-1 items-center justify-center rounded-lg border border-border-strong bg-surface px-3 py-2 text-[14px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2 sm:flex-none sm:py-1.5"
          >
            Export pack
          </Link>
          {data.listing ? (
            <Link
              href={`/listings/${data.listing.id}`}
              className="group inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-[14px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover sm:flex-none sm:py-1.5"
            >
              {data.listing.status === "published" ? "View on eBay" : "Publish to eBay"}
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
            </Link>
          ) : null}
        </div>
      </header>

      {data.actionError ? (
        <Banner variant="error" title="Couldn’t save that">
          {data.actionError}
        </Banner>
      ) : null}
      {data.banner ? (
        <Banner variant={data.banner.variant} title={data.banner.title}>
          {data.banner.detail}
        </Banner>
      ) : null}
      {uncertain ? (
        <Banner variant="warning" title="Is this identification right?">
          {data.identification?.reason ??
            "We couldn't identify this with certainty."}{" "}
          Check the details and price before publishing. The research is only as
          good as the identification.
        </Banner>
      ) : null}

      {/* ---- HERO: carousel + identity/price command column ---- */}
      <section className="grid gap-5 rounded-2xl border border-border bg-surface p-4 shadow-xs sm:grid-cols-[minmax(0,360px)_minmax(0,1fr)] sm:p-5">
        {data.photoUrls.length > 0 ? (
          <PhotoCarousel
            previews={data.photoUrls}
            current={photoIdx}
            onSetCurrent={setPhotoIdx}
            aspectClassName="aspect-[4/5]"
            adaptiveFrame
            className="sm:self-center"
            enableZoom
          />
        ) : (
          <div className="flex aspect-[4/5] w-full items-center justify-center rounded-2xl border border-dashed border-border-strong bg-surface-2 text-faint">
            <svg viewBox="0 0 24 24" className="size-9" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
            </svg>
          </div>
        )}

        {/* identity + price command column — centered as one cluster so the
            slack against a taller portrait image reads as symmetric breathing
            room top/bottom, not a hole in the middle (owner feedback). */}
        <div className="flex min-w-0 flex-col justify-center gap-3">
          <div className="flex items-center justify-between gap-2">
            <Eyebrow>What we found</Eyebrow>
            {/* status said ONCE: a chip only when there's no banner explaining it */}
            {!data.banner && statusChip ? (
              <StatusBadge label={statusChip.label} tone={statusChip.tone} dot={false} />
            ) : null}
          </div>

          <h2 className="font-display text-[22px] font-bold leading-[1.14] tracking-tight text-fg-strong break-words sm:text-[26px]">
            {heroLabel}
          </h2>

          {uncertain && data.identification!.candidates.length > 0 ? (
            <p className="text-[13.5px] text-muted">
              <span className="text-faint">Possible matches: </span>
              {data.identification!.candidates.join(", ")}
            </p>
          ) : null}

          {/* price command center — the ONE home for price + confidence */}
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div>
              <FieldLabel label="Your price" htmlFor="review-price" ai={ai("price")} />
              <div className="flex max-w-[210px] items-center rounded-lg border border-border-strong bg-surface transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
                <span className="pl-3 text-[19px] text-muted">$</span>
                <input
                  id="review-price"
                  name="price"
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={fields.price}
                  onChange={(e) => setField("price", e.target.value)}
                  placeholder={data.suggested != null ? String(data.suggested) : "0.00"}
                  aria-label="Price (USD)"
                  className="w-full rounded-lg bg-transparent px-2 py-2 text-[22px] font-bold text-fg outline-none"
                  data-nums
                />
              </div>
              {data.override != null && data.suggested != null ? (
                <p className="mt-1.5 text-[13px] text-faint" data-nums>
                  AI suggested ${data.suggested}. Clear the field and save to use it again.
                </p>
              ) : null}
            </div>

            {/* intelligence: gauge (the one number) + suggested/range + bar */}
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2/50 p-3.5">
              <div className="flex items-center gap-3">
                <ConfidenceGauge value={data.confidence} size={92} />
                <div className="grid flex-1 grid-cols-2 gap-2">
                  <div>
                    <p className="text-[12px] text-muted">Suggested</p>
                    <p className="mt-0.5 text-[16px] font-bold text-fg-strong" data-nums>
                      {data.suggested != null ? `$${data.suggested}` : "–"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[12px] text-muted">Typical range</p>
                    <p className="mt-0.5 text-[16px] font-bold text-fg-strong" data-nums>
                      {data.range?.low != null && data.range?.high != null
                        ? `$${data.range.low}–$${data.range.high}`
                        : "–"}
                    </p>
                  </div>
                </div>
              </div>
              <RangeBar low={data.range?.low} high={data.range?.high} suggested={data.suggested} />
              {confidenceWord ? (
                <p className="text-[13px] text-muted">
                  <span className="font-semibold text-fg">{confidenceWord}</span>
                  {confidenceChip?.detail ? ` — ${confidenceChip.detail}` : ""}
                  {tier ? ` · ${tier}` : ""}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </section>

      {/* ---- clarify-variant: sharpen a non-high estimate with a missing detail ---- */}
      {canSharpen ? (
        <SharpenCard
          itemId={data.itemId}
          bandWord={confidenceWord}
          candidates={data.identification?.candidates ?? []}
          action={sharpenAction}
        />
      ) : null}

      {/* ---- ONE form spans the stacked cards: every AI field saves together ---- */}
      <form action={saveAction} className="contents">
        <input type="hidden" name="itemId" value={data.itemId} />
        {data.listing ? (
          <input type="hidden" name="listingId" value={data.listing.id} />
        ) : null}

        {/* Your listing — title + description */}
        <SpotlightCard
          chromeClassName={APP_CARD_CHROME}
          spotlightColor="rgba(109, 74, 255, 0.07)"
          className="p-4 sm:p-5"
        >
          <Eyebrow>Your listing</Eyebrow>
          {data.listing ? (
            <div className="mt-3 flex flex-col gap-4">
              <div>
                <FieldLabel
                  label="Title"
                  htmlFor="review-title"
                  ai={ai("title")}
                  aside={
                    <span
                      className={`text-[12px] ${
                        fields.title.length > EBAY_TITLE_MAX
                          ? "font-semibold text-danger-soft-fg"
                          : "text-faint"
                      }`}
                      data-nums
                    >
                      {fields.title.length}/{EBAY_TITLE_MAX}
                    </span>
                  }
                />
                <input
                  id="review-title"
                  name="title"
                  type="text"
                  value={fields.title}
                  maxLength={EBAY_TITLE_MAX}
                  onChange={(e) => setField("title", e.target.value)}
                  className={INPUT_CLASSES}
                />
              </div>
              <div>
                <FieldLabel label="Description" htmlFor="review-description" ai={ai("description")} />
                <textarea
                  id="review-description"
                  name="description"
                  value={fields.description}
                  rows={7}
                  onChange={(e) => setField("description", e.target.value)}
                  className={`${INPUT_CLASSES} min-h-32 resize-y leading-relaxed`}
                />
              </div>
              <p className="text-[13.5px] text-faint">
                Drafted by SnapList from your verified item details
                {data.listing.platform ? ` · ${data.listing.platform} format` : ""}. Fields
                marked with a <SparkleIcon className="inline size-3 text-accent/70" /> are
                AI-suggested — edit anything; your words always win.
              </p>
            </div>
          ) : (
            <p className="mt-3 text-[15px] text-muted">No listing generated yet.</p>
          )}
        </SpotlightCard>

        {/* Item details — the ONE place for every attribute (2-col grid) */}
        <SpotlightCard chromeClassName={APP_CARD_CHROME} className="p-4 sm:p-5">
          <Eyebrow>Item details</Eyebrow>
          <div className="mt-3 grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
            <div>
              <FieldLabel label="Category" htmlFor="review-category" ai={ai("category")} />
              <input
                id="review-category"
                name="category"
                type="text"
                value={fields.category}
                placeholder="e.g. Consumer electronics"
                onChange={(e) => setField("category", e.target.value)}
                className={INPUT_CLASSES}
              />
            </div>
            <div>
              <FieldLabel label="Condition" htmlFor="review-condition" ai={ai("condition")} />
              <input
                id="review-condition"
                name="condition"
                type="text"
                value={fields.condition}
                placeholder="e.g. Good, light wear"
                onChange={(e) => setField("condition", e.target.value)}
                className={INPUT_CLASSES}
              />
            </div>
            {readOnlyAttrs.map(({ key, value }) => (
              <div key={key}>
                <p
                  className={`mb-1 text-[14px] font-medium text-fg ${
                    ATTR_LABELS[key] ? "" : "capitalize"
                  }`}
                >
                  {ATTR_LABELS[key] ?? key}
                </p>
                <p className={READONLY_FIELD}>
                  {value ?? <span className="text-faint">Not detected</span>}
                </p>
              </div>
            ))}
          </div>
        </SpotlightCard>

        {/* ---- contextual save bar (Shopify): appears only when dirty ---- */}
        {dirty ? (
          <div className="pointer-events-none sticky bottom-24 z-30 sm:bottom-5">
            <div className="pointer-events-auto mx-auto flex w-full max-w-md items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#131e3a] px-3 py-2 text-white shadow-lg dark:border-white/15 dark:bg-[#20294e]">
              <span className="flex items-center gap-2 pl-1 text-[14px] font-medium text-white/85">
                <span aria-hidden className="size-1.5 rounded-full bg-warning" />
                Unsaved changes
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={discard}
                  className="rounded-lg border border-white/20 px-3 py-1.5 text-[14px] font-semibold text-white/90 transition-colors hover:bg-white/10"
                >
                  Discard
                </button>
                <PendingButton
                  pendingLabel="Saving…"
                  size="sm"
                  className="!bg-iris !text-white hover:!bg-iris-deep"
                >
                  Save changes
                </PendingButton>
              </span>
            </div>
          </div>
        ) : null}
      </form>
    </main>
  );
}
