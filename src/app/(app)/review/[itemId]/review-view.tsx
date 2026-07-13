"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { PhotoCarousel } from "@/components/ui/photo-carousel";
import { StatusBadge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ConfidenceGauge } from "@/components/ui/confidence-gauge";
import { Banner, type BannerVariant } from "@/components/ui/banner";
import { PendingButton } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { EBAY_TITLE_MAX } from "@/lib/pipeline/review-edits";
import {
  confidenceLabel,
  isLiveListingRow,
  lifecycleLabel,
  sourceKindLabel,
  tierLabel,
} from "@/lib/ui/status";
import { PricingStrategies } from "./pricing-strategies";
import { CostBasisField } from "./cost-basis-field";
import type { PricingStrategy } from "@/lib/pricing/strategies";

/** A dynamic clarify chip (#93): seller-facing label + the spec it adds. */
type ClarifyOption = { label: string; spec: string };

/**
 * Review — Shopify product-edit composition (redesign/review, neutral + green).
 *
 * Modelled on the Shopify product/collection EDIT page
 * (`asset-intake/Shopify web Jan 2024/325` + `328`/`331`): a dark-inked top bar
 * with a back arrow, a short identity title, and the primary action top-right;
 * then a two-column body — a wide LEFT main column of content cards (media,
 * then the editable listing copy) and a narrower RIGHT sidebar that leads with
 * the seller's key DECISION. To give the rail a clear focal point (rather than
 * three equal panels), Price + confidence is the HERO card — elevated chrome, an
 * accent eyebrow, the suggested price colored green — and identification folds
 * into a single quiet Item card (identity + attributes) below it. Everything
 * collapses to one column on mobile (main first, sidebar below), matching
 * Shopify's responsive admin.
 *
 * Palette is the locked neutral + green: near-black ink primary actions
 * (`bg-primary`), green `#008060` reserved for the accent — links, focus rings,
 * the confidence gauge, the price range, money emphasis. Status colour stays on
 * the calm lifecycle pills so green never collides with the emerald "Live".
 * 4-pt spacing, one radius scale, no gradients/glows (ui-design-principles +
 * minimalist-ui skills). Panels are plain (no cursor-spotlight) — the glow read
 * as distracting on a dense edit surface.
 *
 * Client component, pure presentation over serializable props + the actions.
 */

export interface ReviewData {
  itemId: string;
  runId?: string | null;
  photoUrls: string[];
  identification: {
    label: string;
    confident: boolean;
    reason: string | null;
    candidates: string[];
    evidence: number;
  } | null;
  attrs: Array<{ key: string; value: string | null }>;
  /** Current relevant specifications; the correction editor replaces this bounded list. */
  specs: string[];
  listing: {
    id: string;
    platform: string;
    title: string;
    description: string;
    status: string | null;
    ebayListingId?: string | null;
    ebayStatus?: string | null;
  } | null;
  suggested: number | null;
  override: number | null;
  displayPrice: number | null;
  /** What the seller paid (#101); null = unknown (never a fake $0). */
  costBasis: number | null;
  /**
   * Garment measurements (issue #104) — null for non-garments. Each field is a
   * confirmable DRAFT with its always-shown tolerance band; reference-only points
   * (inseam/sleeve) prompt for a tape rather than showing a guessed number.
   */
  measurements: {
    garmentClass: "top" | "bottom";
    fields: Array<{
      name: string;
      label: string;
      value: string;
      toleranceText: string | null;
      method: "reference-scaled" | "prior-based" | "seller-entered" | null;
      confirmed: boolean;
      needsReference: boolean;
    }>;
  } | null;
  range: { low?: number; high?: number } | null;
  confidence: number | null;
  tier: string | null;
  /** The cited comps/lookup records behind the price (PRD story 9). */
  sources: Array<{ url: string; title: string | null; kind: string | null }>;
  /** Quick/Balanced/Maximize points (#94), or a single "Suggested" point. */
  strategies: PricingStrategy[];
  /** Dynamic per-product clarify chips (#93); [] degrades to the detail field. */
  clarifyOptions: ClarifyOption[];
  banner: { variant: BannerVariant; title: string; detail: string } | null;
  actionError: string | null;
}

/** Quiet Shopify panel chrome: hairline border, surface fill, one soft shadow. */
const APP_CARD_CHROME = "rounded-xl border border-border bg-surface shadow-xs";

/**
 * Plain content panel. Replaced the react-bits SpotlightCard — its cursor-tracking
 * "flashlight" glow read as distracting on these dense edit cards (the seller is
 * reading and typing, not browsing marketing). Same chrome, no hover effect.
 */
function Card({
  chromeClassName = APP_CARD_CHROME,
  className,
  children,
}: {
  chromeClassName?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return <div className={`${chromeClassName} ${className ?? ""}`}>{children}</div>;
}

// Fields read as a recessed well: filled with the PAGE colour (`bg-bg`), one
// shade darker than the `bg-surface` card, so the field/card boundary carries
// the contrast. On dark this is the difference that stops inputs blending into
// the panel (#141414 field vs #1f1f1f card); in light it's a soft #f6f6f7 well.
const INPUT_CLASSES =
  "w-full rounded-lg border border-border-strong bg-bg px-3 py-2 text-[15px] text-fg-strong shadow-xs outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/25";

const READONLY_FIELD =
  "rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-[14px] text-fg-strong break-words";

/** Used-goods condition grades — a fixed taxonomy, so Condition is a dropdown
 *  (an AI-supplied descriptive value is preserved as an extra option). */
const CONDITION_OPTIONS = [
  { value: "new", label: "New" },
  { value: "like-new", label: "Like new" },
  { value: "good", label: "Good" },
  { value: "fair", label: "Fair" },
  { value: "for-parts", label: "For parts" },
] as const;

/** Category stays free-text (the taxonomy is open-ended) but offers a typeahead
 *  of common categories so it isn't a blank box. */
const CATEGORY_SUGGESTIONS = [
  "Consumer electronics",
  "Computers & laptops",
  "Cameras & photo",
  "Video games & consoles",
  "Board games & puzzles",
  "Books & media",
  "Home & kitchen",
  "Clothing & accessories",
  "Sporting goods",
  "Toys & collectibles",
  "Musical instruments",
  "Tools & home improvement",
] as const;

/** Human labels for read-only attribute keys that aren't plain words — acronyms
 *  must render UPPERCASE (not "Upc"/"Isbn"). Other keys fall back to capitalize. */
const ATTR_LABELS: Record<string, string> = { upc: "UPC", isbn: "ISBN" };

type FieldKey =
  | "title"
  | "description"
  | "category"
  | "condition"
  | "price"
  | "costBasis";

/** Keep the cited-sources list compact; the rest is summarized as a count. */
const MAX_VISIBLE_SOURCES = 5;

/** Readable fallback link text when a source has no title: its bare hostname.
 *  Only surfaces a hostname for http(s) URLs (the page pre-filters to those);
 *  anything else yields a neutral label rather than echoing a raw scheme. */
function sourceHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "source";
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

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
  ai = false,
  aside,
}: {
  label: string;
  htmlFor: string;
  ai?: boolean;
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
      {/* Decorative track — the $low/$high text below carries the values. */}
      <div aria-hidden className="relative h-1.5 rounded-full bg-surface-3">
        <span className="absolute inset-y-0 left-[6%] right-[6%] rounded-full bg-gradient-to-r from-brand-muted via-brand to-brand-muted opacity-80" />
        {at != null ? (
          <span
            aria-hidden
            className="absolute top-1/2 size-[13px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-surface bg-accent shadow-[0_0_0_3px_var(--color-accent-soft)]"
            style={{ left: `${6 + at * 88}%` }}
          />
        ) : null}
      </div>
      <div className="mt-1.5 flex justify-between text-[12px] font-medium text-muted" data-nums>
        <span>${low}</span>
        <span>${high}</span>
      </div>
    </div>
  );
}

/**
 * "Sharpen the estimate" — shown only when confidence isn't high. The seller
 * confirms details a photo can't reveal (#93: dynamic, per-product chips) and/or
 * types their own (the free-text escape hatch); each becomes a `spec` the re-price
 * action narrows the comp search with. Its OWN form (posts to `sharpenAction`), a
 * SIBLING of the save form — never nested (the layout wrapper is a plain <div>).
 */
function SharpenCard({
  itemId,
  options,
  candidates,
  action,
  formDirty,
}: {
  itemId: string;
  options: ClarifyOption[];
  candidates: string[];
  action: (formData: FormData) => Promise<void>;
  /** The Save form has unsaved edits — Sharpen must confirm before it re-prices
   *  (the re-render replaces the fields, silently discarding those edits). */
  formDirty: boolean;
}) {
  const [chips, setChips] = useState<string[]>([]);
  const [input, setInput] = useState("");
  // Clarify options the seller confirmed apply, keyed by spec.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // Dirty-guard: intercept the first submit while the Save form is dirty and
  // route it through the ConfirmDialog; a confirmed re-submit passes through.
  const formRef = useRef<HTMLFormElement>(null);
  const confirmedRef = useRef(false);
  const [confirming, setConfirming] = useState(false);

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
  const toggleOption = (spec: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(spec)) next.delete(spec);
      else next.add(spec);
      return next;
    });

  // Quick-add the model's own alternative guesses, minus ones already added.
  const suggestions = candidates.filter(
    (c) => !chips.some((chip) => chip.toLowerCase() === c.toLowerCase()),
  );

  // Confirmed options + typed details both become re-price specs; one count
  // grounds the footer so Re-price never sits alone with no context.
  const specCount = picked.size + chips.length;

  return (
    <Card
      chromeClassName={APP_CARD_CHROME}      className="p-4 sm:p-5"
    >
      <form
        ref={formRef}
        action={action}
        onSubmit={(e) => {
          // Unsaved manual edits would be silently overwritten by the re-price's
          // re-render — stop the first submit and ask. A confirm re-submits with
          // the flag set, which passes straight through (and resets the flag).
          if (confirmedRef.current) {
            confirmedRef.current = false;
            return;
          }
          if (formDirty) {
            e.preventDefault();
            setConfirming(true);
          }
        }}
      >
        <input type="hidden" name="itemId" value={itemId} />
        {chips.map((c, i) => (
          <input key={`spec-${i}`} type="hidden" name="spec" value={c} />
        ))}
        {[...picked].map((spec, i) => (
          <input key={`opt-${i}`} type="hidden" name="spec" value={spec} />
        ))}

        <CardTitle>Sharpen the estimate</CardTitle>

        {options.length > 0 ? (
          <div className="mt-4">
            <p className="mb-2.5 text-[13px] font-medium text-fg-strong">
              Confirm what applies
            </p>
            <ul className="flex flex-wrap gap-2">
              {options.map((o) => {
                const on = picked.has(o.spec);
                return (
                  <li key={o.spec}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleOption(o.spec)}
                      // relative + ::before extends the tap target to ~44px
                      // effective on touch without inflating the chip visually.
                      className={`relative inline-flex items-center gap-1.5 rounded-full border py-1.5 text-[13px] font-medium transition-colors before:absolute before:inset-x-0 before:-inset-y-1.5 before:content-[''] ${
                        on
                          ? "border-accent bg-brand-soft pl-2 pr-3 text-accent-soft-fg"
                          : "border-border-strong bg-surface px-3 text-fg hover:border-accent/60 hover:text-accent"
                      }`}
                    >
                      {on ? (
                        <svg aria-hidden viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      ) : null}
                      {o.label}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        <div className="mt-4">
          <label htmlFor="sharpen-detail" className="mb-1.5 block text-[13px] font-medium text-fg-strong">
            {options.length > 0 ? "Add another detail" : "Add a detail"}
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
                    // ::before widens the 16px glyph's tap target (~32px) while
                    // keeping the × visually small inside the chip.
                    className="relative grid size-4 place-items-center rounded-full text-[15px] leading-none text-accent/70 transition-colors before:absolute before:-inset-2 before:content-[''] hover:bg-brand-tint hover:text-accent-soft-fg"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          {suggestions.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[13px] text-muted">Suggestions:</span>
              {suggestions.map((s, i) => (
                <button
                  key={`sugg-${i}`}
                  type="button"
                  onClick={() => addChip(s)}
                  // Same ::before hit-area trick as the toggle chips above.
                  className="relative rounded-full border border-border bg-surface px-3 py-1 text-[13px] text-muted transition-colors before:absolute before:inset-x-0 before:-inset-y-2 before:content-[''] hover:border-accent/60 hover:text-accent"
                >
                  + {s}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] text-muted">
            {specCount === 0 ? (
              "Pick the details that apply, then re-price."
            ) : (
              <>
                <span className="font-semibold text-fg-strong" data-nums>
                  {specCount}
                </span>{" "}
                {specCount === 1 ? "detail" : "details"} added
              </>
            )}
          </p>
          <PendingButton pendingLabel="Re-pricing…" className="w-full sm:w-auto sm:shrink-0">
            Re-price
          </PendingButton>
        </div>
      </form>

      {confirming ? (
        <ConfirmDialog
          title="Discard unsaved edits?"
          body="Sharpen re-runs the pricing research and overwrites the fields you've edited but not saved. Save your changes first if you want to keep them."
          confirmLabel="Run Sharpen"
          cancelLabel="Keep editing"
          pending={false}
          onConfirm={() => {
            setConfirming(false);
            confirmedRef.current = true;
            formRef.current?.requestSubmit();
          }}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </Card>
  );
}

/**
 * Bounded seller identity correction (issue #126). Kept additive to the existing
 * Sharpen flow: this editor replaces load-bearing identity facts and explicitly
 * re-runs BOTH pricing and listing generation, while Sharpen remains the quick
 * additive-spec re-price path. Collapsed by default so the normal review hierarchy
 * and existing Shopify-style design stay intact.
 */
function IdentityCorrectionCard({
  data,
  action,
  formDirty,
}: {
  data: ReviewData;
  action: (formData: FormData) => Promise<void>;
  formDirty: boolean;
}) {
  const attr = (key: string) => data.attrs.find((a) => a.key === key)?.value ?? "";
  const [fields, setFields] = useState(() => ({
    brand: attr("brand"),
    model: attr("model"),
    category: attr("category"),
    condition: attr("condition").toLowerCase(),
    isbn: attr("isbn"),
    upc: attr("upc"),
    specifications: data.specs.join("\n"),
  }));
  const formRef = useRef<HTMLFormElement>(null);
  const confirmedRef = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const setField = (key: keyof typeof fields, value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }));

  return (
    <Card chromeClassName={APP_CARD_CHROME} className="p-4 sm:p-5">
      <details>
        <summary className="cursor-pointer list-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent/30">
          <span className="flex items-center justify-between gap-4">
            <span>
              <span className="block text-[14px] font-semibold tracking-tight text-fg-strong">
                Correct item identity
              </span>
              <span className="mt-1 block text-[13px] leading-relaxed text-muted">
                Fix the facts that drive comparable sales and generated listing copy.
              </span>
            </span>
            <span className="shrink-0 text-[13px] font-semibold text-accent">
              Edit details
            </span>
          </span>
        </summary>

        <form
          ref={formRef}
          action={action}
          className="mt-5 border-t border-border pt-5"
          onSubmit={(event) => {
            if (confirmedRef.current) {
              confirmedRef.current = false;
              return;
            }
            if (formDirty) {
              event.preventDefault();
              setConfirming(true);
            }
          }}
        >
          <input type="hidden" name="itemId" value={data.itemId} />
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel label="Brand" htmlFor="identity-brand" />
              <input
                id="identity-brand"
                name="brand"
                value={fields.brand}
                onChange={(e) => setField("brand", e.target.value)}
                maxLength={120}
                className={INPUT_CLASSES}
              />
            </div>
            <div>
              <FieldLabel label="Model" htmlFor="identity-model" />
              <input
                id="identity-model"
                name="model"
                value={fields.model}
                onChange={(e) => setField("model", e.target.value)}
                maxLength={120}
                className={INPUT_CLASSES}
              />
            </div>
            <div>
              <FieldLabel label="Category" htmlFor="identity-category" />
              <input
                id="identity-category"
                name="category"
                list="identity-category-options"
                value={fields.category}
                onChange={(e) => setField("category", e.target.value)}
                maxLength={120}
                className={INPUT_CLASSES}
              />
              <datalist id="identity-category-options">
                {CATEGORY_SUGGESTIONS.map((category) => (
                  <option key={category} value={category} />
                ))}
              </datalist>
            </div>
            <div>
              <FieldLabel label="Condition" htmlFor="identity-condition" />
              <Select
                id="identity-condition"
                name="condition"
                value={fields.condition}
                onChange={(value) => setField("condition", value)}
                placeholder="Select a condition…"
                options={[...CONDITION_OPTIONS]}
                className="w-full bg-bg px-3 py-2 text-[15px] text-fg-strong shadow-xs"
              />
            </div>
            <div>
              <FieldLabel label="ISBN (if applicable)" htmlFor="identity-isbn" />
              <input
                id="identity-isbn"
                name="isbn"
                inputMode="numeric"
                value={fields.isbn}
                onChange={(e) => setField("isbn", e.target.value)}
                maxLength={20}
                className={INPUT_CLASSES}
              />
            </div>
            <div>
              <FieldLabel label="UPC (if applicable)" htmlFor="identity-upc" />
              <input
                id="identity-upc"
                name="upc"
                inputMode="numeric"
                value={fields.upc}
                onChange={(e) => setField("upc", e.target.value)}
                maxLength={20}
                className={INPUT_CLASSES}
              />
            </div>
          </div>
          <div className="mt-4">
            <FieldLabel
              label="Relevant specifications"
              htmlFor="identity-specifications"
              aside={<span className="text-[12px] text-faint">One per line, max 12</span>}
            />
            <textarea
              id="identity-specifications"
              name="specifications"
              value={fields.specifications}
              onChange={(e) => setField("specifications", e.target.value)}
              rows={4}
              placeholder={"e.g. 512GB SSD\nNoise cancelling\nBlack"}
              className={`${INPUT_CLASSES} resize-y leading-relaxed`}
            />
          </div>

          <div className="mt-5 flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-xl text-[13px] leading-relaxed text-muted">
              This replaces the generated suggestion and copy as one saved result. Your
              saved price override is kept and the listing stays a draft.
            </p>
            <PendingButton
              pendingLabel="Re-pricing & regenerating…"
              className="w-full sm:w-auto sm:shrink-0"
            >
              Re-price &amp; regenerate
            </PendingButton>
          </div>
        </form>
      </details>

      {confirming ? (
        <ConfirmDialog
          title="Discard unsaved listing edits?"
          body="Re-price and regenerate replaces the current generated suggestion and copy. Save your manual title, description, price, cost-basis, or measurement edits first if you want to keep them. Saved price overrides are always preserved."
          confirmLabel="Re-price & regenerate"
          cancelLabel="Keep editing"
          pending={false}
          onConfirm={() => {
            setConfirming(false);
            confirmedRef.current = true;
            formRef.current?.requestSubmit();
          }}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </Card>
  );
}

/** One garment measurement field (issue #104). */
type MeasureField = NonNullable<ReviewData["measurements"]>["fields"][number];

/**
 * Whether a live entry still equals the server draft value it was rendered from,
 * compared at DISPLAY precision: `rendered` is the server value via trimInches (2dp)
 * while `entered` holds the raw input, so an entry that rounds to the rendered value
 * ("22.50" → "22.5", "21.999" → "22") reads as unchanged. Rounding both to 2dp
 * mirrors the save path (`parseMeasurementEdits`), which treats an edit as real only
 * when it differs at 2dp. Drives both the Unsaved-changes bar and the tolerance-band
 * display, so a seller-edited value never shows the draft's stale band or method.
 * Blank/blank and blank/value are handled by the string equality + both-non-empty guard.
 */
function sameMeasureValue(entered: string, rendered: string): boolean {
  const a = entered.trim();
  const b = rendered.trim();
  if (a === b) return true;
  const an = Number(a);
  const bn = Number(b);
  return (
    a !== "" &&
    b !== "" &&
    Number.isFinite(an) &&
    Number.isFinite(bn) &&
    Number(an.toFixed(2)) === Number(bn.toFixed(2))
  );
}

/**
 * Measurements card (issue #104) — clothing only. Renders the garment type's
 * measurement set as confirmable DRAFTS: the four listing-grade measurements arrive
 * pre-filled with an always-shown tolerance band ("~21 in ± 1"); inseam/sleeve (and
 * other reference-only points) stay blank behind a "lay a tape measure" prompt
 * rather than a guessed number. Only measurements the seller ticks Confirm are used
 * to ground buyer-Q&A replies; unconfirmed drafts are never quoted to a buyer —
 * mirroring the confidence-gating philosophy. Fields associate to the Save form by
 * `form="rv-save"`, so they ride the existing save flow and Unsaved-changes bar.
 */
function MeasurementsCard({
  fields,
  values,
  confirmed,
  onValue,
  onConfirm,
}: {
  fields: MeasureField[];
  values: Record<string, string>;
  confirmed: Record<string, boolean>;
  onValue: (name: string, value: string) => void;
  onConfirm: (name: string, checked: boolean) => void;
}) {
  return (
    <Card chromeClassName={APP_CARD_CHROME} className="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <CardTitle>Measurements</CardTitle>
        <span className="text-[11px] font-medium uppercase tracking-[0.1em] text-faint">
          Draft
        </span>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">
        Estimated flat-lay measurements, in inches. Check each value and tick{" "}
        <span className="font-medium text-fg-strong">Confirm</span> to vouch for it —
        only measurements you confirm are used to answer buyer questions about sizing;
        unconfirmed estimates are never quoted to a buyer. For sleeve and inseam, lay a
        tape measure across the garment and re-photograph, or type your own measurement.
      </p>

      <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {fields.map((f) => {
          const hasValue = values[f.name]?.trim() !== "" && values[f.name] != null;
          // Once the seller edits the value away from the server draft, that draft's
          // tolerance band ("~21 in ± 1") and method are stale — the save path treats
          // the edit as a hand-measured, seller-entered value (tolerance 0). Reflect
          // that live: hide the band and show "Measured by you" instead of quoting a
          // number/derivation that no longer matches the input.
          const edited = hasValue && !sameMeasureValue(values[f.name] ?? "", f.value);
          const effectiveMethod = edited ? "seller-entered" : f.method;
          const methodNote =
            effectiveMethod === "seller-entered"
              ? "Measured by you"
              : effectiveMethod === "reference-scaled"
                ? "Measured against a reference in the photo"
                : effectiveMethod === "prior-based"
                  ? "Estimated from the photo"
                  : f.needsReference
                    ? "Needs a tape measure in the photo"
                    : "Not measured yet";
          return (
            <li
              key={f.name}
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-2 p-3"
            >
              <label
                htmlFor={`measurement-${f.name}`}
                className="text-[13px] font-medium text-fg-strong"
              >
                {f.label}
              </label>
              <div className="flex items-center rounded-lg border border-border-strong bg-bg transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
                <input
                  id={`measurement-${f.name}`}
                  name={`measurement_${f.name}`}
                  form="rv-save"
                  type="number"
                  inputMode="decimal"
                  step="any"
                  min="0"
                  value={values[f.name] ?? ""}
                  onChange={(e) => onValue(f.name, e.target.value)}
                  placeholder={f.needsReference ? "Measure with tape" : "0"}
                  aria-label={`${f.label} in inches`}
                  className="w-full rounded-lg bg-transparent px-2.5 py-1.5 text-[15px] font-semibold text-fg-strong outline-none"
                  data-nums
                />
                <span className="pr-2.5 text-[13px] text-muted">in</span>
              </div>
              <p className="text-[12px] text-faint">
                {hasValue && f.toleranceText && !edited && !confirmed[f.name] ? (
                  <span className="text-muted" data-nums>
                    {f.toleranceText}
                  </span>
                ) : (
                  methodNote
                )}
              </p>
              <label
                className={`mt-0.5 inline-flex items-center gap-2 text-[13px] ${
                  hasValue ? "text-fg-strong" : "cursor-not-allowed text-faint"
                }`}
              >
                <input
                  type="checkbox"
                  name="measurement_confirmed"
                  value={f.name}
                  form="rv-save"
                  checked={confirmed[f.name] ?? false}
                  disabled={!hasValue}
                  onChange={(e) => onConfirm(f.name, e.target.checked)}
                  className="size-4 accent-[var(--color-accent)]"
                />
                Confirm
              </label>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

interface ReviewViewProps {
  data: ReviewData;
  saveAction: (formData: FormData) => Promise<void>;
  sharpenAction: (formData: FormData) => Promise<void>;
  regenerateAction: (formData: FormData) => Promise<void>;
}

export function reviewStateKey(
  data: Pick<ReviewData, "itemId" | "runId">,
): string {
  return `${data.itemId}:${data.runId ?? "legacy"}`;
}

export function ReviewView(props: ReviewViewProps) {
  return <ReviewViewState key={reviewStateKey(props.data)} {...props} />;
}

function ReviewViewState({
  data,
  saveAction,
  sharpenAction,
  regenerateAction,
}: ReviewViewProps) {
  const attr = (key: string) =>
    data.attrs.find((a) => a.key === key)?.value ?? "";

  const initial = useMemo(
    () => ({
      title: data.listing?.title ?? "",
      description: data.listing?.description ?? "",
      category: attr("category"),
      condition: attr("condition"),
      price: data.displayPrice != null ? String(data.displayPrice) : "",
      costBasis: data.costBasis != null ? String(data.costBasis) : "",
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- derived purely from the serializable prop
    [data],
  );

  const [fields, setFields] = useState(initial);
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [photoIdx, setPhotoIdx] = useState(0);
  const listingIsLive = data.listing
    ? isLiveListingRow({
        ebay_listing_id: data.listing.ebayListingId,
        ebay_status: data.listing.ebayStatus,
      })
    : false;

  // Garment measurements (issue #104): their own controlled state, folded into the
  // same dirty/save/discard flow as the other fields.
  const measureFields = data.measurements?.fields ?? [];
  const initialMeasures = useMemo(
    () => ({
      values: Object.fromEntries(measureFields.map((f) => [f.name, f.value])),
      confirmed: Object.fromEntries(measureFields.map((f) => [f.name, f.confirmed])),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- derived purely from the serializable prop
    [data],
  );
  const [measureValues, setMeasureValues] = useState(initialMeasures.values);
  const [measureConfirmed, setMeasureConfirmed] = useState(initialMeasures.confirmed);

  const setField = (key: FieldKey, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
    setTouched((prev) => (prev[key] ? prev : { ...prev, [key]: true }));
  };
  const setMeasureValue = (name: string, value: string) => {
    setMeasureValues((prev) => ({ ...prev, [name]: value }));
    // Clearing a value can't stay "confirmed" — a blank measurement isn't a fact.
    if (value.trim() === "") {
      setMeasureConfirmed((prev) => ({ ...prev, [name]: false }));
    }
  };
  const setMeasureConfirm = (name: string, checked: boolean) =>
    setMeasureConfirmed((prev) => ({ ...prev, [name]: checked }));
  const discard = () => {
    setFields(initial);
    setTouched({});
    setMeasureValues(initialMeasures.values);
    setMeasureConfirmed(initialMeasures.confirmed);
  };

  // `sameMeasureValue` (module scope) compares a live entry to the server draft at
  // display precision — shared with the tolerance-band display so both agree on what
  // counts as an edit.
  const measuresDirty = measureFields.some(
    (f) =>
      !sameMeasureValue(measureValues[f.name] ?? "", f.value) ||
      (measureConfirmed[f.name] ?? false) !== f.confirmed,
  );
  const dirty =
    (Object.keys(initial) as FieldKey[]).some((key) => fields[key] !== initial[key]) ||
    measuresDirty;

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
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-5 px-4 pt-6 pb-28 sm:px-6 sm:pb-24">
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
              className="inline-flex flex-1 items-center justify-center rounded-lg bg-primary px-3.5 py-2 text-[14px] font-semibold text-primary-fg shadow-xs transition-colors hover:bg-primary-hover sm:flex-none sm:py-1.5"
            >
              {data.listing.status === "published" ? "View on eBay" : "Publish to eBay"}
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

      {/* ---- two-column editor. The LAYOUT wrapper is a plain <div> (NOT a form)
           so the Sharpen card's own form can sit inside the right rail without
           nesting in the Save form (nested <form>s are invalid HTML). Every
           editable field below associates with the Save form by id —
           form="rv-save" — and the form element itself trails the layout,
           carrying the action + the contextual Save bar. ---- */}
      {/* Shopify product-edit proportion: a WIDER media+copy main column and a
          narrower detail rail (the rail's three cards run as long as the taller
          media column, so the two end close together — "even"). */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-6">
        {/* ============ LEFT main column: media + listing copy ============ */}
        <div className="flex min-w-0 flex-col gap-5">
          {/* Media — the product photos (Shopify "Media" block). */}
          <Card
            chromeClassName={APP_CARD_CHROME}            className="p-4 sm:p-5"
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
          </Card>

          {/* Listing details — title + description (Shopify "Description" block). */}
          <Card
            chromeClassName={APP_CARD_CHROME}            className="p-4 sm:p-5"
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
                    form="rv-save"
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
                    form="rv-save"
                    value={fields.description}
                    rows={8}
                    onChange={(e) => setField("description", e.target.value)}
                    className={`${INPUT_CLASSES} min-h-40 resize-y leading-relaxed`}
                  />
                </div>
              </div>
            ) : (
              <p className="mt-3 text-[15px] text-muted">No listing generated yet.</p>
            )}
          </Card>

          {/* Measurements — clothing only (issue #104). Draft measurements the
              seller confirms to ground buyer-Q&A replies about sizing. */}
          {data.measurements && measureFields.length > 0 ? (
            <MeasurementsCard
              fields={measureFields}
              values={measureValues}
              confirmed={measureConfirmed}
              onValue={setMeasureValue}
              onConfirm={setMeasureConfirm}
            />
          ) : null}

        </div>

        {/* ============ RIGHT rail: decision -> meta ============
             Hierarchy (ui-design-principles): one focal card, not equal panels.
             Price + confidence is the seller's key judgment, so it leads as the
             hero (elevated chrome, accent eyebrow, colored suggested price);
             identification folds into the quiet Item card below it. Sharpen now
             lives full-width under both columns, so this rail (hero + item)
             ends close to the media + copy column on the left. */}
        <aside className="flex flex-col gap-5 lg:sticky lg:top-[88px] lg:self-start">
          {/* Price & confidence — HERO. Stronger border + soft elevation set it
              apart from the calm meta card; the green dash eyebrow leads the eye. */}
          <Card
            chromeClassName="rounded-xl border border-border-strong bg-surface shadow-sm"            className="p-4 sm:p-5"
          >
            <span className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">
              <span aria-hidden className="h-[2px] w-5 rounded-full bg-accent" />
              Price &amp; confidence
            </span>
            <div className="mt-3">
              <FieldLabel label="Your price" htmlFor="review-price" ai={ai("price")} />
              <div className="flex items-center rounded-lg border border-border-strong bg-surface transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/25">
                <span className="pl-3 text-[22px] text-muted">$</span>
                <input
                  id="review-price"
                  name="price"
                  form="rv-save"
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0.01"
                  value={fields.price}
                  onChange={(e) => setField("price", e.target.value)}
                  placeholder={data.suggested != null ? String(data.suggested) : "0.00"}
                  aria-label="Price (USD)"
                  className="w-full rounded-lg bg-transparent px-2 py-2 text-[26px] font-bold tracking-tight text-fg-strong outline-none"
                  data-nums
                />
              </div>
              {data.override != null && data.suggested != null ? (
                <p className="mt-1.5 text-[12.5px] text-muted" data-nums>
                  AI suggested ${data.suggested}. Clear the field and save to use it again.
                </p>
              ) : null}
            </div>

            {/* #101 — cost basis + live est. net profit (margin, not list price). */}
            <CostBasisField
              value={fields.costBasis}
              onChange={(v) => setField("costBasis", v)}
              priceText={fields.price}
              fallbackPrice={data.suggested}
            />

            {/* intelligence: gauge (the one number) + suggested/range + bar.
                Suggested is colored green (the AI/brand recommendation) so the
                eye lands on it; the range stays a strong neutral. */}
            <div className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-3.5">
              <div className="flex items-center gap-3">
                <ConfidenceGauge value={data.confidence} size={84} />
                <div className="grid flex-1 grid-cols-2 gap-2">
                  <div>
                    <p className="text-[12px] text-muted">Suggested</p>
                    <p className="mt-0.5 whitespace-nowrap text-[16px] font-bold text-accent-soft-fg" data-nums>
                      {data.suggested != null ? `$${data.suggested}` : "–"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[12px] text-muted">Typical range</p>
                    <p className="mt-0.5 whitespace-nowrap text-[16px] font-bold text-fg-strong" data-nums>
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

              {/* Cited sources (PRD story 9): the checkable comps/lookup records
                  behind the suggestion, so the seller can verify the price
                  instead of trusting a bare number. Quiet by design — small
                  muted links with a kind tag, capped with an honest count. */}
              {data.sources.length > 0 ? (
                <div className="border-t border-border pt-3">
                  <p className="text-[12px] font-medium text-muted">Sources behind this price</p>
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {data.sources.slice(0, MAX_VISIBLE_SOURCES).map((s, i) => {
                      const kind = sourceKindLabel(s.kind);
                      return (
                        <li
                          key={`${s.url}-${i}`}
                          className="flex items-baseline gap-1.5 text-[12.5px]"
                        >
                          <a
                            href={s.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="min-w-0 truncate text-muted underline decoration-border-strong underline-offset-2 transition-colors hover:text-accent"
                          >
                            {s.title ?? sourceHost(s.url)}
                          </a>
                          {kind ? (
                            <span className="shrink-0 text-[11px] text-faint">{kind}</span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                  {data.sources.length > MAX_VISIBLE_SOURCES ? (
                    <p className="mt-1.5 text-[11.5px] text-faint" data-nums>
                      +{data.sources.length - MAX_VISIBLE_SOURCES} more comparable
                      {data.sources.length - MAX_VISIBLE_SOURCES === 1 ? " sale" : " sales"} behind
                      this price
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            {/* #94 — Quick/Balanced/Maximize selector. Renders only when a real
                comp distribution backs it; picking one sets the price field and
                rides the existing save flow. */}
            <PricingStrategies
              strategies={data.strategies}
              selected={fields.price}
              onPick={(p) => setField("price", String(p))}
              costBasisText={fields.costBasis}
            />
          </Card>

          {/* Item — identification + attributes in ONE quiet meta card (Shopify
              "Organization"). The identified name leads; editable category/
              condition and the detected attributes sit below a divider. */}
          <Card
            chromeClassName={APP_CARD_CHROME}            className="p-4 sm:p-5"
          >
            <CardTitle>Item details</CardTitle>
            <p className="mt-2.5 text-[15px] font-bold leading-snug tracking-tight text-fg-strong break-words">
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

            <div className="mt-4 flex flex-col gap-3.5 border-t border-border pt-4">
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
          </Card>

        </aside>

      </div>

      {data.listing && data.listing.status !== "published" && !listingIsLive ? (
        <IdentityCorrectionCard
          data={data}
          action={regenerateAction}
          formDirty={dirty}
        />
      ) : null}

      {/* Sharpen / re-price — FULL-WIDTH below the two columns. Its OWN form
          (sharpenAction); the layout wrapper above is a plain <div>, so this
          never nests inside the Save form (nested <form>s are invalid HTML).
          Going full width lets the clarify chips run as an even two-column grid
          instead of one tall stack, and keeps the left/right columns balanced
          (the rail no longer outruns the media column). Shown only when
          confidence isn't high. */}
      {canSharpen ? (
        <SharpenCard
          itemId={data.itemId}
          options={data.clarifyOptions}
          candidates={data.identification?.candidates ?? []}
          action={sharpenAction}
          formDirty={dirty}
        />
      ) : null}

      {/* ---- Save form: owns saveAction + the contextual Save bar. The editable
           fields above associate to it by id (form="rv-save"), so they still
           submit together even though the layout is a plain <div>; the
           PendingButton lives inside this form so useFormStatus reads it. ---- */}
      <form id="rv-save" action={saveAction}>
        <input type="hidden" name="itemId" value={data.itemId} />
        {/* Identity edits belong to the explicit correction/regeneration action.
            Preserve the current values in the ordinary listing-save payload so
            `saveReview` cannot clear them while saving copy/price/measurements. */}
        <input type="hidden" name="category" value={fields.category} />
        <input type="hidden" name="condition" value={fields.condition} />
        {data.listing ? (
          <input type="hidden" name="listingId" value={data.listing.id} />
        ) : null}
        {dirty ? (
          <div className="pointer-events-none fixed inset-x-0 bottom-24 z-40 px-4 sm:bottom-5 sm:left-[var(--sidebar-w)]">
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
