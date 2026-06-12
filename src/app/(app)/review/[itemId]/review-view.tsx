"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import FadeContent from "@/components/bits/FadeContent";
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
 * Review — Shopify product-detail layout (issue #40 round 2), made EDITABLE in
 * the UI pass: every AI-filled field (title, description, category, condition,
 * price) renders as a real input pre-filled with the suggestion and wearing a
 * small "AI" sparkle badge that disappears the moment the seller edits — the
 * pipeline proposes, the seller disposes. One form spans both columns; a
 * Shopify-style contextual save bar (navy, sticky) appears when anything is
 * dirty and submits through the page's server action.
 *
 * Client component, but still pure presentation over serializable props — the
 * page (and the dev preview harness) feed the data + the action.
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
const APP_CARD_CHROME = "rounded-xl border border-border bg-surface shadow-xs";

const INPUT_CLASSES =
  "w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-fg outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20";

type FieldKey = "title" | "description" | "category" | "condition" | "price";

function SparkleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 2.5c.3 0 .57.2.66.49l1.4 4.6a3 3 0 0 0 1.99 1.99l4.6 1.4a.69.69 0 0 1 0 1.32l-4.6 1.4a3 3 0 0 0-1.99 1.99l-1.4 4.6a.69.69 0 0 1-1.32 0l-1.4-4.6a3 3 0 0 0-1.99-1.99l-4.6-1.4a.69.69 0 0 1 0-1.32l4.6-1.4a3 3 0 0 0 1.99-1.99l1.4-4.6c.09-.29.36-.49.66-.49Z" />
    </svg>
  );
}

/**
 * The editability affordance: a tiny violet sparkle pill on fields still
 * showing the pipeline's suggestion. It vanishes on first edit — the field
 * was never locked, the badge only marks provenance.
 */
function AiBadge({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span
      title="Suggested by SnapList — edit freely"
      className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-px text-[10px] font-semibold leading-4 text-accent-soft-fg"
    >
      <SparkleIcon className="size-2.5" />
      AI-suggested
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
        <label
          htmlFor={htmlFor}
          className="text-[13px] font-medium text-fg"
        >
          {label}
        </label>
        <AiBadge visible={ai} />
      </span>
      {aside}
    </span>
  );
}

export function ReviewView({
  data,
  saveAction,
}: {
  data: ReviewData;
  saveAction: (formData: FormData) => Promise<void>;
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
  // The price badge additionally requires that no seller override is already
  // persisted — an overridden price is the seller's number, not the AI's.
  const ai = (key: FieldKey) =>
    !touched[key] &&
    initial[key] !== "" &&
    (key !== "price" ? true : data.override == null && data.suggested != null);

  const statusChip = lifecycleLabel(data.listing?.status ?? null);
  const confidenceChip = confidenceLabel(data.confidence);
  const tier = tierLabel(data.tier);

  const readOnlyAttrs = data.attrs.filter(
    (a) => a.key !== "category" && a.key !== "condition",
  );

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-4 px-4 py-6 sm:px-6">
      {/* ---- header: back + title + chip, actions right (Shopify) ---- */}
      <header className="flex flex-wrap items-center gap-3">
        <Link
          href="/dashboard"
          aria-label="Back to listings"
          className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-surface text-muted shadow-xs transition-colors hover:text-fg"
        >
          <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </Link>
        <h1 className="min-w-0 flex-1 truncate font-display text-[22px] font-bold tracking-tight text-fg-strong">
          {(fields.title || data.identification?.label) ?? "Review listing"}
        </h1>
        {statusChip ? (
          <StatusBadge label={statusChip.label} tone={statusChip.tone} dot={false} />
        ) : null}
        <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
          <Link
            href={`/export/${data.itemId}`}
            className="inline-flex items-center rounded-lg border border-border-strong bg-surface px-3 py-1.5 text-[13px] font-semibold text-fg shadow-xs transition-colors hover:bg-surface-2"
          >
            Export pack
          </Link>
          {data.listing ? (
            <Link
              href={`/listings/${data.listing.id}`}
              className="inline-flex items-center rounded-lg bg-primary px-3.5 py-1.5 text-[13px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover"
            >
              {data.listing.status === "published"
                ? "View on eBay"
                : "Publish to eBay"}
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
      {data.identification && !data.identification.confident ? (
        <Banner variant="warning" title="Is this identification right?">
          {data.identification.reason ??
            "We couldn't identify this with certainty."}{" "}
          Check the details and price before publishing — the research is only
          as good as the identification.
        </Banner>
      ) : null}

      {/* ---- ONE form spans both columns: every AI field saves together ---- */}
      <form action={saveAction} className="contents">
        <input type="hidden" name="itemId" value={data.itemId} />
        {data.listing ? (
          <input type="hidden" name="listingId" value={data.listing.id} />
        ) : null}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_310px]">
          {/* ===== main column ===== */}
          <div className="flex min-w-0 flex-col gap-4">
            {/* Listing card: title + description as REAL fields */}
            <section className="rounded-xl border border-border bg-surface p-4 shadow-xs sm:p-5">
              <h2 className="mb-3 text-[13px] font-semibold text-fg-strong">
                Listing
              </h2>
              {data.listing ? (
                <div className="flex flex-col gap-4">
                  <div>
                    <FieldLabel
                      label="Title"
                      htmlFor="review-title"
                      ai={ai("title")}
                      aside={
                        <span
                          className={`text-[11px] ${
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
                    <FieldLabel
                      label="Description"
                      htmlFor="review-description"
                      ai={ai("description")}
                    />
                    <textarea
                      id="review-description"
                      name="description"
                      value={fields.description}
                      rows={7}
                      onChange={(e) => setField("description", e.target.value)}
                      className={`${INPUT_CLASSES} min-h-32 resize-y leading-relaxed`}
                    />
                  </div>
                  <p className="text-xs text-faint">
                    Drafted by SnapList from your verified item details
                    {data.listing.platform ? ` · ${data.listing.platform} format` : ""}
                    . Edit anything — your words always win.
                  </p>
                </div>
              ) : (
                <p className="text-sm text-muted">No listing generated yet.</p>
              )}
            </section>

            {/* Media card */}
            <section className="rounded-xl border border-border bg-surface p-4 shadow-xs sm:p-5">
              <h2 className="mb-3 text-[13px] font-semibold text-fg-strong">Media</h2>
              {data.photoUrls.length > 0 ? (
                /* react-bits FadeContent: one soft blur-up entrance for the
                   photo grid (reduced-motion safe inside the component). */
                <FadeContent blur duration={500} className="flex flex-wrap gap-2">
                  {data.photoUrls.map((url, i) => (
                    // eslint-disable-next-line @next/next/no-img-element -- short-lived signed Storage URLs
                    <img
                      key={url}
                      src={url}
                      alt={`Item photo ${i + 1}`}
                      className={
                        i === 0
                          ? "size-36 rounded-lg border border-border object-cover"
                          : "size-[4.25rem] rounded-lg border border-border object-cover"
                      }
                    />
                  ))}
                </FadeContent>
              ) : (
                <p className="text-sm text-muted">No photos.</p>
              )}
            </section>

            {/* Pricing card — react-bits SpotlightCard wearing app chrome: a
                soft violet spotlight follows the cursor over the money card. */}
            <SpotlightCard
              chromeClassName={APP_CARD_CHROME}
              spotlightColor="rgba(109, 74, 255, 0.09)"
              className="p-4 sm:p-5"
            >
              <h2 className="mb-3 text-[13px] font-semibold text-fg-strong">Pricing</h2>
              <div className="flex flex-col gap-4">
                <div className="max-w-56">
                  <FieldLabel
                    label="Price"
                    htmlFor="review-price"
                    ai={ai("price")}
                  />
                  <div className="flex items-center rounded-lg border border-border-strong bg-surface transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20">
                    <span className="pl-3 text-sm text-muted">$</span>
                    <input
                      id="review-price"
                      name="price"
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={fields.price}
                      onChange={(e) => setField("price", e.target.value)}
                      placeholder={
                        data.suggested != null ? String(data.suggested) : "0.00"
                      }
                      aria-label="Price (USD)"
                      className="w-full rounded-lg bg-transparent px-2 py-2 text-sm text-fg outline-none"
                      data-nums
                    />
                  </div>
                  {data.override != null && data.suggested != null ? (
                    <p className="mt-1.5 text-xs text-faint" data-nums>
                      AI suggested ${data.suggested} — clear the field and save
                      to use it again.
                    </p>
                  ) : null}
                </div>

                {/* Pricing intelligence — animated gauge + Suggested/Range
                    (the marketing site's promise, kept in the product) */}
                <div className="flex items-center gap-4 rounded-lg border border-border bg-surface-2/60 px-4 py-3">
                  <ConfidenceGauge value={data.confidence} size={120} />
                  <div className="grid flex-1 grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs text-muted">Suggested</p>
                      <p className="mt-0.5 text-[15px] font-bold text-fg-strong" data-nums>
                        {data.suggested != null ? `$${data.suggested}` : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-muted">Typical range</p>
                      <p className="mt-0.5 text-[15px] font-bold text-fg-strong" data-nums>
                        {data.range?.low != null && data.range?.high != null
                          ? `$${data.range.low}–$${data.range.high}`
                          : "—"}
                      </p>
                    </div>
                  </div>
                </div>

                {confidenceChip ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge
                      label={confidenceChip.label}
                      tone={confidenceChip.tone}
                      dot={false}
                    />
                    <span className="text-xs text-muted">
                      {confidenceChip.detail}
                      {tier ? ` · based on: ${tier}` : ""}
                    </span>
                  </div>
                ) : null}
              </div>
            </SpotlightCard>
          </div>

          {/* ===== sidebar (SpotlightCard hover treatment on all three) ===== */}
          <div className="flex flex-col gap-4">
            {/* Status card */}
            <SpotlightCard chromeClassName={APP_CARD_CHROME} className="p-4">
              <h2 className="mb-2 text-[13px] font-semibold text-fg-strong">Status</h2>
              {statusChip ? (
                <StatusBadge label={statusChip.label} tone={statusChip.tone} dot={false} />
              ) : (
                <p className="text-sm text-muted">No sale listing yet.</p>
              )}
              {data.banner ? (
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  {data.banner.detail}
                </p>
              ) : null}
            </SpotlightCard>

            {/* Identification card (the "Insights" slot) */}
            {data.identification ? (
              <SpotlightCard chromeClassName={APP_CARD_CHROME} className="p-4">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h2 className="text-[13px] font-semibold text-fg-strong">
                    Identification
                  </h2>
                  {data.identification.confident ? (
                    <StatusBadge label="Identified" tone="success" dot={false} />
                  ) : (
                    <StatusBadge label="Needs confirmation" tone="warning" dot={false} />
                  )}
                </div>
                <p className="text-sm font-medium text-fg">{data.identification.label}</p>
                {data.identification.candidates.length > 0 ? (
                  <p className="mt-1.5 text-xs text-muted">
                    Possible matches: {data.identification.candidates.join(", ")}
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs text-faint">
                    {(data.identification.evidence * 100).toFixed(0)}% of strong
                    identifiers resolved
                  </p>
                )}
              </SpotlightCard>
            ) : null}

            {/* Item details card — category + condition are REAL fields too */}
            <SpotlightCard chromeClassName={APP_CARD_CHROME} className="p-4">
              <h2 className="mb-3 text-[13px] font-semibold text-fg-strong">
                Item details
              </h2>
              <div className="flex flex-col gap-3.5">
                <div>
                  <FieldLabel
                    label="Category"
                    htmlFor="review-category"
                    ai={ai("category")}
                  />
                  <input
                    id="review-category"
                    name="category"
                    type="text"
                    value={fields.category}
                    placeholder="e.g. Consumer electronics"
                    onChange={(e) => setField("category", e.target.value)}
                    className={`${INPUT_CLASSES} px-2.5 py-1.5 text-[13px]`}
                  />
                </div>
                <div>
                  <FieldLabel
                    label="Condition"
                    htmlFor="review-condition"
                    ai={ai("condition")}
                  />
                  <input
                    id="review-condition"
                    name="condition"
                    type="text"
                    value={fields.condition}
                    placeholder="e.g. Good — light wear"
                    onChange={(e) => setField("condition", e.target.value)}
                    className={`${INPUT_CLASSES} px-2.5 py-1.5 text-[13px]`}
                  />
                </div>
                <dl className="flex flex-col gap-2.5 border-t border-border pt-3">
                  {readOnlyAttrs.map(({ key, value }) => (
                    <div key={key}>
                      <dt className="text-xs capitalize text-muted">{key}</dt>
                      <dd className="mt-0.5 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1.5 text-[13px] text-fg">
                        {value ?? <span className="text-faint">— not detected</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </SpotlightCard>
          </div>
        </div>

        {/* ---- contextual save bar (Shopify): appears only when dirty ---- */}
        {dirty ? (
          <div className="pointer-events-none sticky bottom-24 z-30 sm:bottom-5">
            {/* Pinned ink navy (bg-fg-strong flips near-white in dark, which
                would break the white inner text); dark gets a raised navy. */}
            <div className="pointer-events-auto mx-auto flex w-full max-w-md items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#131e3a] px-3 py-2 text-white shadow-lg dark:border-white/15 dark:bg-[#20294e]">
              <span className="flex items-center gap-2 pl-1 text-[13px] font-medium text-white/85">
                <span aria-hidden className="size-1.5 rounded-full bg-warning" />
                Unsaved changes
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={discard}
                  className="rounded-lg border border-white/20 px-3 py-1.5 text-[12.5px] font-semibold text-white/90 transition-colors hover:bg-white/10"
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
