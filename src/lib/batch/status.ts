import type { StatusLabel } from "../ui/status";

/**
 * Batch triage status derivation (issue #100) — pure translation from what is
 * persisted (the item's latest listing status, or the absence of a listing)
 * plus the orchestrator's transport state into the triage-list vocabulary:
 *
 *   pending → priced → needs-review / ready-to-publish (± failed / blocked)
 *
 * Reuses the raw listing lifecycle keys the single-item path writes
 * (`initialListingStatus`: `draft` | `queued`; the eBay publish path writes
 * `published`) — no new persisted vocabulary, only a triage-time reading of it.
 * Tones map to the same semantic status colors as `lifecycleLabel` so batch
 * rows never contradict the dashboard's chips for the same listing.
 */

export type TriageStatusKey =
  /** Run dispatched (or about to be); no listing row yet. */
  | "processing"
  /** Priced + drafted, below the eligibility gate — needs human review. */
  | "needs-review"
  /** Priced + drafted, above the eligibility gate (listing status `queued`). */
  | "autopilot-eligible"
  /** Already live on eBay after the seller's manual publish. */
  | "live"
  /** The pipeline run failed for this item — retryable. */
  | "failed"
  /** Skipped by the daily spend guardrail — retryable when quota allows. */
  | "blocked"
  /** Not yet dispatched by the orchestrator. */
  | "waiting";

/**
 * Derive the triage key from a persisted listing status. `null`/`undefined`
 * (no listing yet) reads as still processing. Unknown/late-lifecycle keys
 * (e.g. `archived`, `failed` from a later publish attempt) degrade to
 * `needs-review` — every batch row links to the item's normal review page,
 * which renders the authoritative state.
 */
export function triageStatusFromListing(
  listingStatus: string | null | undefined,
): TriageStatusKey {
  switch (listingStatus) {
    case null:
    case undefined:
    case "new":
      return "processing";
    case "draft":
      return "needs-review";
    case "queued":
      return "autopilot-eligible";
    case "published":
      return "live";
    case "failed":
    case "draft_failed":
      return "failed";
    default:
      return "needs-review";
  }
}

/** Triage key → end-user chip (same StatusLabel shape `StatusBadge` renders). */
export function triageLabel(key: TriageStatusKey): StatusLabel {
  switch (key) {
    case "waiting":
      return { label: "Waiting", tone: "neutral" };
    case "processing":
      return { label: "Processing", tone: "info", pulse: true };
    case "needs-review":
      return { label: "Needs review", tone: "warning" };
    case "autopilot-eligible":
      return { label: "Ready to publish", tone: "success" };
    case "live":
      return { label: "Active", tone: "success-solid" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "blocked":
      return { label: "Daily limit", tone: "danger" };
  }
}

/** Terminal for the batch run itself (polling may still move listing states). */
export function isTerminalTriageStatus(key: TriageStatusKey): boolean {
  return key !== "waiting" && key !== "processing";
}
