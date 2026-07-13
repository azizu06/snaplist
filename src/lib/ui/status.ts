/**
 * Status / confidence / tier vocabulary — ONE source of truth for every
 * user-facing surface (issue #40, audit fix X-4).
 *
 * Raw persisted values (listing status keys, the confidence composite, pricing
 * tier keys) stay untouched in the data layer; these helpers translate them at
 * display time. No page may render a raw status/tier key directly — that is how
 * "tier: web_tight" leaked to end users.
 *
 * Tones map to the semantic status colors in globals.css `@theme` and render as
 * soft tonal badges (see `StatusBadge`), Shopify Products-style, so each state
 * is distinguishable at a glance: Active is green (success), Draft is amber
 * (warning, "unfinished"), Ready to publish and Processing are blue (info),
 * Needs attention is red (danger), and only Archived stays calm grey (neutral,
 * "dormant"). Color carries meaning here — it is not decoration.
 */

import { DEFAULT_AUTOPILOT_THRESHOLD } from "../confidence/confidence";

export type StatusTone =
  | "success"
  | "success-solid"
  | "warning"
  | "danger"
  | "info"
  | "neutral";

export interface StatusLabel {
  label: string;
  tone: StatusTone;
  /** Transient "working" states (Processing) set this so their badge dot pulses
   *  (motion-safe). It differentiates them from static ready/info states. */
  pulse?: boolean;
  icon?: "clock";
}

/** Listing lifecycle → end-user chip. Unknown keys render as themselves (honest), never invented. */
export function lifecycleLabel(status: string | null | undefined): StatusLabel | null {
  if (status == null) return null;
  switch (status) {
    case "draft":
      return { label: "Draft", tone: "warning" };
    case "queued":
      return { label: "Ready to publish", tone: "info" };
    case "published":
      return { label: "Active", tone: "success-solid" };
    case "failed":
    case "draft_failed":
      return { label: "Needs attention", tone: "danger" };
    case "new":
      // Shares info-blue with Ready to publish; pulses so the transient
      // working state still reads as active when scanned.
      return { label: "Processing", tone: "info", pulse: true };
    case "archived":
      return { label: "Archived", tone: "neutral" };
    default:
      return { label: status, tone: "neutral" };
  }
}

/**
 * Compact chip for narrow surfaces (mobile rows, the ⌘K palette) — same
 * tones as lifecycleLabel so color meaning never diverges; only the copy
 * shortens. Unknown keys fall through to the long label's honest rendering.
 */
export function lifecycleShortLabel(
  status: string | null | undefined,
): StatusLabel | null {
  const full = lifecycleLabel(status);
  if (!full) return null;
  switch (status) {
    case "draft":
      return { label: "Draft", tone: full.tone };
    case "queued":
      return { label: "Ready to publish", tone: full.tone };
    case "failed":
    case "draft_failed":
      return { label: "Attention", tone: full.tone };
    default:
      return full;
  }
}

/**
 * The ONLY listing statuses a seller may set through the dashboard bulk quick-edit
 * grid. Deliberately seller-organizational only:
 *  - `published` (Active/Live) is written ONLY by the eBay publish path, alongside
 *    `ebay_listing_id` + `ebay_status`. Letting a bulk metadata edit write it would
 *    mark an UNPOSTED draft "Live" without ever touching the eBay adapter (Codex P1).
 *  - `queued` (Ready to publish) is assigned ONLY by the confidence gate; setting
 *    it by hand would falsely claim an item met that eligibility rule.
 * Both are excluded; bulk-edit can only pull a listing back to review or archive it.
 * Shared by the grid's options AND the `bulkUpdateListings` server guard so the UI
 * and the write boundary can never drift.
 */
export const BULK_EDITABLE_STATUSES = ["draft", "archived"] as const;

/** Is `status` one a seller may set via the bulk quick-edit grid? */
export function isBulkEditableStatus(status: string): boolean {
  return (BULK_EDITABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * Is this listing row LIVE on eBay? A listing is live iff it has an eBay listing
 * id AND its eBay-side status is `published`. A live listing's lifecycle is owned
 * by the eBay state, so dashboard mutations must never write a non-live status
 * (draft/archived) onto it and mislabel a genuinely live listing (Codex). This is
 * the ONE definition of "live", shared by `archiveListings`, `unarchiveListings`,
 * and `bulkUpdateListings` so the predicate can never drift between them — each
 * caller keeps its own read + error policy, but they all decide "live" identically.
 */
export function isLiveListingRow(row: {
  ebay_listing_id?: string | null;
  ebay_status?: string | null;
}): boolean {
  return Boolean(row.ebay_listing_id) && row.ebay_status === "published";
}

/**
 * What a bulk quick-edit status write reduces to, made pure so the lifecycle guard
 * that took six review rounds to get right is unit-tested directly instead of
 * buried in Supabase I/O glue:
 *  - `skip`         — no status change requested, or the row has no listing yet.
 *  - `reject-vocab` — a status outside the seller-organizational set (published /
 *                     queued / …): only a crafted request past the disabled UI can
 *                     reach this; never written (defense-in-depth, Codex P1).
 *  - `skip-live`    — the listing is live on eBay; its status is owned by the eBay
 *                     state, so a bulk edit must not move it to draft/archived.
 *  - `write`        — a bulk-editable status on a non-live listing: the only case
 *                     that actually persists.
 */
export type BulkStatusDecision = "skip" | "reject-vocab" | "skip-live" | "write";

export function bulkStatusDecision(params: {
  status: string | undefined;
  hasListing: boolean;
  isLive: boolean;
}): BulkStatusDecision {
  if (params.status === undefined || !params.hasListing) return "skip";
  if (!isBulkEditableStatus(params.status)) return "reject-vocab";
  if (params.isLive) return "skip-live";
  return "write";
}

export type ConfidenceBand = "high" | "medium" | "low";

const MEDIUM_MIN = 0.5;

/**
 * Bands mirror the publish-eligibility gate: high = eligible (the SAME
 * threshold the pipeline gates on, imported so they can't drift), medium ≥ 0.5,
 * else low.
 */
export function confidenceBand(
  confidence: number | null | undefined,
): ConfidenceBand | null {
  if (confidence == null) return null;
  if (confidence >= DEFAULT_AUTOPILOT_THRESHOLD) return "high";
  if (confidence >= MEDIUM_MIN) return "medium";
  return "low";
}

export interface ConfidenceLabel extends StatusLabel {
  /** The consequence line (R-3): what this band means for the seller. */
  detail: string;
}

export function confidenceLabel(
  confidence: number | null | undefined,
): ConfidenceLabel | null {
  const band = confidenceBand(confidence);
  if (band == null || confidence == null) return null;
  const pct = `${Math.round(confidence * 100)}%`;
  switch (band) {
    case "high":
      return {
        label: `High confidence (${pct})`,
        detail: "Eligible for manual publish",
        tone: "success",
      };
    case "medium":
      return {
        label: `Medium confidence (${pct})`,
        detail: "Worth a quick check",
        tone: "warning",
      };
    case "low":
      return {
        label: `Low confidence (${pct})`,
        detail: "Please double-check before publishing",
        tone: "neutral",
      };
  }
}

/**
 * Price-source `kind` keys (priceSourceSchema) → plain language for the cited
 * sources list (PRD story 9). Unknown/missing kinds return null — the link
 * still renders, just without a tag — so a raw key never reaches the user.
 */
export function sourceKindLabel(kind: string | null | undefined): string | null {
  switch (kind) {
    case "isbn-lookup":
      return "ISBN lookup";
    case "sold-comp":
      return "Sold comp";
    case "asking-comp":
      return "Asking price";
    case "retail-price":
      return "Retail price";
    default:
      return null;
  }
}

/** Pricing tier keys → plain language (R-1). Unknown future tiers degrade to a generic honest label. */
export function tierLabel(tier: string | null | undefined): string | null {
  if (tier == null) return null;
  switch (tier) {
    case "isbn-lookup":
      return "Exact match: ISBN lookup";
    case "ebay-sold":
      return "Verified eBay sold comps";
    case "web_tight":
      return "Strong market comps";
    case "web_wide":
      return "Mixed market comps";
    case "depreciation":
      return "Estimated from retail price";
    case "llm_only":
      return "Rough AI estimate";
    default:
      return "AI estimate";
  }
}
