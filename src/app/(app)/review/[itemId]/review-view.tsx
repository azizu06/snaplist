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
 * Review — Shopify product-edit composition (redesign/review, neutral + green).
 *
 * Modelled on the Shopify product/collection EDIT page
 * (`asset-intake/Shopify web Jan 2024/325` + `328`/`331`): a dark-inked top bar
 * with a back arrow, a short identity title, and the primary action top-right;
 * then a two-column body — a wide LEFT main column of content cards (media,
 * then the editable listing copy) and a narrower RIGHT sidebar of metadata
 * cards (identification/status, price + confidence, item attributes). Each card
 * is a quiet white panel: hairline border, one soft shadow, a small section
 * heading. Everything collapses to one column on mobile (main first, sidebar
 * below), matching Shopify's responsive admin.
 *
 * Palette is the locked neutral + green: near-black ink primary actions
 * (`bg-primary`), green `#008060` reserved for the accent — links, focus rings,
 * the confidence gauge, the price range, money emphasis. Status colour stays on
 * the calm lifecycle pills so green never collides with the emerald "Live".
 * 4-pt spacing, one radius scale, no gradients/glows (ui-design-principles +
 * minimalist-ui skills). Keeps the react-bits SpotlightCard on every panel.
 *
 * Client component, pure presentation over serializable props + the actions.
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

/** App-card chrome for the react-bits SpotlightCard (vs its marketing default):
 *  a quiet Shopify panel — hairline border, white surface, one soft shadow. */
const APP_CARD_CHROME = "rounded-xl border border-border bg-surface shadow-xs";

/** Green spotlight to match the accent (the react-bits flair, kept subtle). */
const SPOTLIGHT = "rgba(0, 128, 96, 0.06)";

const INPUT_CLASSES =
  "w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-[15px] text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/25";

const READONLY_FIELD =
  "rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-[14px] text-fg break-words";

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
 * Provenance affordance: a single faint green sparkle marking a field that
 * still shows the pipeline's suggestion; vanishes on first edit. The field is
 * never locked — green here means "AI-drafted, edit freely", consistent with
 * the accent's "positive / brand" role.
 */
function AiSparkle({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span title="Suggested by SnapList; edit freely" className="text-accent/80">
      <SparkleIcon className="size-3" />
    </span>
  );
}

/** Shopify section heading — a small, quiet bold title that opens each card. */
function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[14px] font-semibold tracking-tight text-fg-strong">
      {children}
    </h2>
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
    <span className="mb-1.5 flex items-center justify-between gap-2">
      <span className="flex items-center gap-1.5">
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-fg-strong">
          {label}
        </label>
        <AiSparkle visible={ai} />
      </span>
      {aside}
    </span>
  );
}

/** Visual price range — a green track with the suggested price as a marker,
 *  low/high endpoints labeled. The accent carries the resale band. */
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
        <span className="absolute inset-y-0 left-[6%] right-[6%] rounded-full bg-gradient-to-r from-brand-muted via-brand to-brand-muted opacity-80" />
        {at != null ? (
          <span
            aria-hidden
            className="absolute top-1/2 size-[13px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-surface bg-accent shadow-[0_0_0_3px_var(--color-accent-soft)]"
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
      spotlightColor={SPOTLIGHT}
      className="p-4 sm:p-5"
    >
      <form action={action}>
        <input type="hidden" name="itemId" value={itemId} />
        {chips.map((c, i) => (
          <input key={`spec-${i}`} type="hidden" name="spec" value={c} />
        ))}

        <CardTitle>Sharpen the estimate</CardTitle>
        <p className="mt-2 max-w-prose text-[14px] leading-relaxed text-muted">
          Confidence is {bandWord ? bandWord.toLowerCase() : "limited"} because the photo
          can’t show everything that sets the price. Add a detail we couldn’t see — the
          exact model, GPU, storage, or year — and we’ll re-research the comps.
        </p>

        <div className="mt-4">
          <label htmlFor="sharpen-detail" className="mb-1.5 block text-[13px] font-medium text-fg-strong">
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
                  className="inline-flex items-center gap-1.5 rounded-full border border-brand-tint bg-brand-soft py-1 pl-3 pr-1.5 text-[13px] font-medium text-accent-soft-fg"
                >
                  {c}
                  <button
                    type="button"
                    onClick={() => removeChip(i)}
                    aria-label={`Remove ${c}`}
                    className="grid size-4 place-items-center rounded-full text-[15px] leading-none text-accent/70 transition-colors hover:bg-brand-tint hover:text-accent-soft-fg"
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
                  className="rounded-full border border-border bg-surface px-3 py-1 text-[13px] text-muted transition-colors hover:border-accent/60 hover:text-accent"
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
  // full descriptive name still lives in the Identification card; the SEO title
  // stays in the editable Title field.
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
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 py-6 sm:px-6">
      {/* ---- top bar: back + identity left, page actions right (Shopify 325) ---- */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/dashboard"
            aria-label="Back to listings"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted shadow-xs transition-colors hover:bg-surface-2 hover:text-fg-strong"
          >
            <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </Link>
          <div className="flex min-w-0 flex-col">
            <h1 className="min-w-0 truncate font-display text-[20px] font-bold tracking-tight text-fg-strong sm:text-[22px]">
              {shortName}
            </h1>
            {!data.banner && statusChip ? (
              <span className="mt-0.5 flex sm:hidden">
                <StatusBadge label={statusChip.label} tone={statusChip.tone} />
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2 sm:ml-auto sm:shrink-0">
          {!data.banner && statusChip ? (
            <span className="hidden sm:flex">
              <StatusBadge label={statusChip.label} tone={statusChip.tone} />
            </span>
          ) : null}
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

      {/* ---- ONE form spans both columns: every editable field saves together ---- */}
      <form
        action={saveAction}
        className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_340px]"
      >
        <input type="hidden" name="itemId" value={data.itemId} />
        {data.listing ? (
          <input type="hidden" name="listingId" value={data.listing.id} />
        ) : null}

        {/* ============ LEFT main column: media + listing copy ============ */}
        <div className="flex min-w-0 flex-col gap-5">
          {/* Media — the product photos (Shopify "Media" block). */}
          <SpotlightCard
            chromeClassName={APP_CARD_CHROME}
            spotlightColor={SPOTLIGHT}
            className="p-4 sm:p-5"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <CardTitle>Photos</CardTitle>
              {data.photoUrls.length > 1 ? (
                <span className="text-[12px] text-faint" data-nums>
                  {data.photoUrls.length} photos
                </span>
              ) : null}
            </div>
            {data.photoUrls.length > 0 ? (
              <PhotoCarousel
                previews={data.photoUrls}
                current={photoIdx}
                onSetCurrent={setPhotoIdx}
                aspectClassName="aspect-[4/3]"
                adaptiveFrame
                enableZoom
              />
            ) : (
              <div className="flex aspect-[4/3] w-full items-center justify-center rounded-2xl border border-dashed border-border-strong bg-surface-2 text-faint">
                <svg viewBox="0 0 24 24" className="size-9" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <circle cx="9" cy="9" r="2" />
                  <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
                </svg>
              </div>
            )}
          </SpotlightCard>

          {/* Listing details — title + description (Shopify "Description" block). */}
          <SpotlightCard
            chromeClassName={APP_CARD_CHROME}
            spotlightColor={SPOTLIGHT}
            className="p-4 sm:p-5"
          >
            <CardTitle>Listing details</CardTitle>
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
                    rows={8}
                    onChange={(e) => setField("description", e.target.value)}
                    className={`${INPUT_CLASSES} min-h-40 resize-y leading-relaxed`}
                  />
                </div>
                <p className="text-[13px] text-faint">
                  Drafted by SnapList from your verified item details
                  {data.listing.platform ? ` · ${data.listing.platform} format` : ""}. Fields
                  marked with a <SparkleIcon className="inline size-3 text-accent/80" /> are
                  AI-suggested — edit anything; your words always win.
                </p>
              </div>
            ) : (
              <p className="mt-3 text-[15px] text-muted">No listing generated yet.</p>
            )}
          </SpotlightCard>

          {/* clarify-variant: sharpen a non-high estimate with a missing detail */}
          {canSharpen ? (
            <SharpenCard
              itemId={data.itemId}
              bandWord={confidenceWord}
              candidates={data.identification?.candidates ?? []}
              action={sharpenAction}
            />
          ) : null}
        </div>

        {/* ============ RIGHT sidebar: identification · price · attributes ============ */}
        <aside className="flex flex-col gap-5">
          {/* Identification — "what we found" + candidates (Shopify metadata card). */}
          <SpotlightCard
            chromeClassName={APP_CARD_CHROME}
            spotlightColor={SPOTLIGHT}
            className="p-4 sm:p-5"
          >
            <CardTitle>Identification</CardTitle>
            <p className="mt-2.5 text-[16px] font-bold leading-snug tracking-tight text-fg-strong break-words">
              {heroLabel}
            </p>
            {uncertain && data.identification!.candidates.length > 0 ? (
              <div className="mt-2.5">
                <p className="text-[12px] font-medium text-faint">Possible matches</p>
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {data.identification!.candidates.map((c) => (
                    <li
                      key={c}
                      className="rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[12.5px] text-muted"
                    >
                      {c}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </SpotlightCard>

          {/* Price — the ONE home for price + confidence + range. */}
          <SpotlightCard
            chromeClassName={APP_CARD_CHROME}
            spotlightColor={SPOTLIGHT}
            className="p-4 sm:p-5"
          >
            <CardTitle>Price</CardTitle>
            <div className="mt-3">
              <FieldLabel label="Your price" htmlFor="review-price" ai={ai("price")} />
              <div className="flex items-center rounded-lg border border-border-strong bg-surface transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
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
                  className="w-full rounded-lg bg-transparent px-2 py-2 text-[22px] font-bold text-fg-strong outline-none"
                  data-nums
                />
              </div>
              {data.override != null && data.suggested != null ? (
                <p className="mt-1.5 text-[12.5px] text-faint" data-nums>
                  AI suggested ${data.suggested}. Clear the field and save to use it again.
                </p>
              ) : null}
            </div>

            {/* intelligence: gauge (the one number) + suggested/range + bar */}
            <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-3.5">
              <div className="flex items-center gap-3">
                <ConfidenceGauge value={data.confidence} size={84} />
                <div className="grid flex-1 grid-cols-2 gap-2">
                  <div>
                    <p className="text-[12px] text-muted">Suggested</p>
                    <p className="mt-0.5 text-[15px] font-bold text-fg-strong" data-nums>
                      {data.suggested != null ? `$${data.suggested}` : "–"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[12px] text-muted">Typical range</p>
                    <p className="mt-0.5 text-[15px] font-bold text-fg-strong" data-nums>
                      {data.range?.low != null && data.range?.high != null
                        ? `$${data.range.low}–$${data.range.high}`
                        : "–"}
                    </p>
                  </div>
                </div>
              </div>
              <RangeBar low={data.range?.low} high={data.range?.high} suggested={data.suggested} />
              {confidenceWord ? (
                <p className="text-[12.5px] leading-relaxed text-muted">
                  <span className="font-semibold text-fg-strong">{confidenceWord}</span>
                  {confidenceChip?.detail ? ` — ${confidenceChip.detail}` : ""}
                  {tier ? ` · ${tier}` : ""}
                </p>
              ) : null}
            </div>
          </SpotlightCard>

          {/* Item details — every attribute in one place (Shopify "Organization"). */}
          <SpotlightCard
            chromeClassName={APP_CARD_CHROME}
            spotlightColor={SPOTLIGHT}
            className="p-4 sm:p-5"
          >
            <CardTitle>Item details</CardTitle>
            <div className="mt-3 flex flex-col gap-3.5">
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
              {readOnlyAttrs.length > 0 ? (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border pt-3.5">
                  {readOnlyAttrs.map(({ key, value }) => (
                    <div key={key}>
                      <dt
                        className={`mb-1 text-[13px] font-medium text-fg-strong ${
                          ATTR_LABELS[key] ? "" : "capitalize"
                        }`}
                      >
                        {ATTR_LABELS[key] ?? key}
                      </dt>
                      <dd className={READONLY_FIELD}>
                        {value ?? <span className="text-faint">Not detected</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </div>
          </SpotlightCard>
        </aside>

        {/* ---- contextual save bar (Shopify): appears only when dirty ---- */}
        {dirty ? (
          <div className="pointer-events-none sticky bottom-24 z-30 sm:bottom-5 lg:col-span-2">
            <div className="pointer-events-auto mx-auto flex w-full max-w-md items-center justify-between gap-3 rounded-xl border border-border-strong bg-flash px-3 py-2 text-primary-fg shadow-lg">
              <span className="flex items-center gap-2 pl-1 text-[14px] font-medium text-primary-fg/90">
                <span aria-hidden className="size-1.5 rounded-full bg-warning" />
                Unsaved changes
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={discard}
                  className="rounded-lg border border-primary-fg/25 px-3 py-1.5 text-[14px] font-semibold text-primary-fg/90 transition-colors hover:bg-primary-fg/10"
                >
                  Discard
                </button>
                <PendingButton
                  pendingLabel="Saving…"
                  size="sm"
                  className="!bg-accent !text-accent-fg hover:!bg-accent-hover"
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
