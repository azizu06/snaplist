/**
 * Status / confidence / tier vocabulary — ONE source of truth for every
 * user-facing surface (issue #40, audit fix X-4).
 *
 * Raw persisted values (listing status keys, the confidence composite, pricing
 * tier keys) stay untouched in the data layer; these helpers translate them at
 * display time. No page may render a raw status/tier key directly — that is how
 * "tier: web_tight" leaked to end users.
 *
 * Tones map to the semantic status colors in globals.css `@theme`:
 * success (emerald) · success-solid (filled emerald, reserved for Live) ·
 * warning (amber) · danger (red) · neutral (gray).
 */

import { DEFAULT_AUTOPILOT_THRESHOLD } from "../confidence/confidence";

export type StatusTone = "success" | "success-solid" | "warning" | "danger" | "neutral";

export interface StatusLabel {
  label: string;
  tone: StatusTone;
}

/** Listing lifecycle → end-user chip. Unknown keys render as themselves (honest), never invented. */
export function lifecycleLabel(status: string | null | undefined): StatusLabel | null {
  if (status == null) return null;
  switch (status) {
    case "draft":
      return { label: "Draft — needs review", tone: "warning" };
    case "queued":
      return { label: "Queued — autopilot will post", tone: "success" };
    case "published":
      return { label: "Live", tone: "success-solid" };
    case "failed":
    case "draft_failed":
      return { label: "Needs attention", tone: "danger" };
    case "new":
      return { label: "Processing", tone: "neutral" };
    default:
      return { label: status, tone: "neutral" };
  }
}

export type ConfidenceBand = "high" | "medium" | "low";

const MEDIUM_MIN = 0.5;

/**
 * Bands mirror the autopilot gate: high = autopilot-eligible (the SAME
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
        detail: "Strong enough for autopilot",
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

/** Pricing tier keys → plain language (R-1). Unknown future tiers degrade to a generic honest label. */
export function tierLabel(tier: string | null | undefined): string | null {
  if (tier == null) return null;
  switch (tier) {
    case "isbn-lookup":
      return "Exact match: ISBN lookup";
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
