import {
  computeConfidence,
  type ConfidenceResult,
  type ConfidenceSignals,
  type ConfidenceTier,
  type IdentificationSignals,
} from "./confidence";
import type { PriceResult } from "../pricing/types";
import { TIGHT_AGREEMENT_MIN } from "../pricing/providers/web-search";
import type { ExtractedAttributes } from "../pipeline/types";

/**
 * The price → confidence BRIDGE: maps a `PriceResult` (pricing-tier vocabulary)
 * onto the confidence-tier vocabulary and derives the composite's signals. This is
 * the #31/#32/#60 publish-eligibility calibration — the single most safety-critical
 * mapping in the app — so it lives HERE, in the confidence module, and every
 * consumer (the vision pipeline's run, `pipeline/reprice.ts`, the walking-skeleton
 * stub's identification signals) imports it as a peer. Moved from
 * `vision/pipeline.ts` so the calibration has one home and can't drift.
 */

/** Does this price cite a real SOLD comp (vs only catalog/asking lookups)? */
function hasSoldComp(price: PriceResult): boolean {
  return price.sources.some((s) => s.kind === "sold-comp");
}

/**
 * Count of DISTINCT source hosts — a proxy for INDEPENDENT corroboration. Five
 * listings on one site are not five independent signals; five sites agreeing is a
 * real market consensus. `www.` is folded; an unparseable url falls back to its raw
 * string so it still counts as its own bucket (never silently merged).
 */
function independentSourceCount(price: PriceResult): number {
  const hosts = new Set<string>();
  for (const s of price.sources) {
    try {
      hosts.add(new URL(s.url).hostname.replace(/^www\./, ""));
    } catch {
      hosts.add(s.url);
    }
  }
  return hosts.size;
}

/**
 * Minimum INDEPENDENT asking sources for the `web_tight` trust bump. A couple of
 * agreeing asking prices is weak; a broad consensus across distinct sites is real
 * evidence — still below completed sales, but enough to be ready-for-manual-publish eligible.
 */
const WEB_TIGHT_MIN_SOURCES = 4;

/**
 * A no-sold-comp ASKING cluster strong enough to earn the `web_tight` tier (0.80) —
 * the web-search coverage lever for products with many agreeing LISTINGS but few
 * completed sales. Requires BOTH: DEMONSTRATED tightness (a REPORTED
 * `compAgreement >= TIGHT_AGREEMENT_MIN`, never the unreported-null default) AND
 * broad INDEPENDENT corroboration (>= WEB_TIGHT_MIN_SOURCES distinct sites). It is
 * deliberately bounded: it ranks below `sold`, and the score math still maps a
 * borderline-tight cluster below the readiness threshold — asking consensus earns
 * *more* trust than before, not a blank check (asking ≠ sold).
 */
function stronglyCorroboratedAsking(price: PriceResult): boolean {
  return (
    !hasSoldComp(price) &&
    price.compAgreement != null &&
    price.compAgreement >= TIGHT_AGREEMENT_MIN &&
    independentSourceCount(price) >= WEB_TIGHT_MIN_SOURCES
  );
}

/** Did the provider judge its comp cluster tight? (Unreported = no objection.) */
function tightAgreement(price: PriceResult): boolean {
  return price.compAgreement == null || price.compAgreement >= TIGHT_AGREEMENT_MIN;
}

/**
 * Map the firing PRICING tier onto the CONFIDENCE vocabulary — they are distinct sets
 * (`isbn-lookup`/`branded-web`/… vs `isbn`/`web_tight`/…); this bridges them.
 *
 * #31 calibration: an `isbn-lookup` price backed ONLY by catalog lookups (Open Library /
 * Google Books — no sold comp) is a retail-DERIVED estimate, not a comped price, so we
 * trust it at the `depreciation` level (0.4), NOT the top `isbn` tier (0.95). A book
 * priced off new-retail therefore can't reach the ready-to-publish band on identity
 * alone; the ISBN identity still feeds the identification signals. A sold-comp
 * lookup restores the high `isbn` trust.
 *
 * #32 calibration (same principle, web tier): the pricing contract permits `branded-web`
 * to cite asking-only / scattered sources, so it does NOT automatically deserve a high-trust
 * tier. Earn the sold-grounded `sold` tier ONLY with a real sold comp AND a tight cluster;
 * otherwise map to `web_wide`. Without this, a fully-identified branded item with a single
 * asking comp scores 0.6·0.8 + 0.25·1 + 0.15·0.4 = 0.79 and clears the 0.75 eligibility gate
 * with no sold comp or demonstrated clustering; `web_wide` lands it at 0.67, safely sub-gate.
 *
 * #60: a completed-SALE comp ("sold beats asking", ADR-0001) earns the first-class `sold`
 * confidence tier — ranked ABOVE the asking-based web tiers — instead of being folded onto
 * `web_tight`. A scattered sold set still degrades to `web_wide` (real evidence of *a*
 * market, not a defensible tight price), so a wide sale spread cannot ride the label past
 * the gate; tightness rides on the provider's judged `compAgreement`.
 */
function pricingTierToConfidenceTier(price: PriceResult): ConfidenceTier {
  switch (price.tier) {
    case "isbn-lookup":
      return hasSoldComp(price) ? "isbn" : "depreciation";
    case "ebay-sold":
      // eBay sold comps are completed sales — sold-grounded by construction, so
      // the only question is tightness. A tight cluster earns the first-class
      // `sold` tier (above the asking-based web tiers, #60); a scattered sold set
      // stays `web_wide` (real evidence of *a* market, not a defensible tight price).
      return tightAgreement(price) ? "sold" : "web_wide";
    case "upc-aided-web":
      // A broadly-corroborated tight asking cluster earns web_tight; otherwise wide.
      return stronglyCorroboratedAsking(price) ? "web_tight" : "web_wide";
    case "branded-web":
      // #10 round-4 calibration: the `sold` tier needs BOTH sold grounding AND the
      // provider's judged tight agreement. A scattered sold set ($60/$185/$420)
      // is real evidence of *a* market but not of a defensible tight price —
      // it stays web_wide and cannot ride the sold-comp label past the
      // publish-eligibility gate. Providers that don't report agreement (e.g. injected
      // test pricers) keep the sold-comp-only behavior.
      if (hasSoldComp(price) && tightAgreement(price)) return "sold";
      // Coverage lever: a tight cluster across many INDEPENDENT asking sources earns
      // `web_tight` (0.80) — real consensus, still ranked below completed sales.
      return stronglyCorroboratedAsking(price) ? "web_tight" : "web_wide";
    case "depreciation":
      return "depreciation";
    case "llm-only":
    default:
      return "llm_only";
  }
}

/**
 * Without sold grounding, judged agreement is capped here: a tight cluster of
 * ASKING prices proves sellers agree on what to ask, not what buyers pay, so
 * it must not push a no-sold-comp item over the publish-eligibility gate (full-id
 * asking-only would otherwise score 0.6·0.6 + 0.25·1 + 0.15·1 = 0.76 ≥ 0.75).
 * 0.4 matches the conservative no-sold constant below: full-id asking-only
 * tops out at 0.67, safely sub-gate.
 */
const ASKING_AGREEMENT_CAP = 0.4;

/**
 * Comp-agreement signal for the confidence composite: the provider's own
 * judged agreement when reported (the web tiers measure relative spread) —
 * capped without sold grounding — else the conservative constants for
 * providers without a comp cluster.
 */
function compAgreementFor(price: PriceResult): number {
  if (price.compAgreement != null) {
    // Sold grounding OR a broadly-corroborated tight asking cluster (web_tight) has
    // EARNED its agreement — use it uncapped. A thin/under-corroborated asking set
    // stays capped (sellers agreeing on asking ≠ buyers agreeing on paying).
    if (hasSoldComp(price) || stronglyCorroboratedAsking(price)) return price.compAgreement;
    return Math.min(price.compAgreement, ASKING_AGREEMENT_CAP);
  }
  if (hasSoldComp(price)) return 0.7;
  return price.sources.length > 0 ? 0.4 : 0.3;
}

/**
 * The identification-completeness booleans, derived from extracted EVIDENCE
 * (never the model's self-reported ambiguity — issue #3). Shared by the real
 * pipeline's bridge and the walking-skeleton stub so "what counts as resolved"
 * is defined exactly once.
 */
export function identificationSignalsFrom(
  attributes: ExtractedAttributes,
): IdentificationSignals {
  return {
    brandResolved: attributes.brand != null,
    modelResolved: attributes.model != null,
    barcodeDecoded: attributes.upc != null || attributes.isbn != null,
    categoryUnambiguous: attributes.category != null,
  };
}

/**
 * Build the confidence input from DETERMINISTIC signals: the firing tier (mapped +
 * #31-calibrated), a conservative comp-agreement, and extracted-evidence identification
 * booleans. NEVER the model's self-reported `ambiguous` flag — that stays a user-facing
 * identification warning, not a score input (issue #3, signal-based composite).
 */
export function confidenceSignalsFor(
  attributes: ExtractedAttributes,
  price: PriceResult,
): ConfidenceSignals {
  return {
    tier: pricingTierToConfidenceTier(price),
    compAgreement: compAgreementFor(price),
    identification: identificationSignalsFrom(attributes),
  };
}

/**
 * The calibrated price → confidence mapping, exported so a RE-PRICE (clarify-variant,
 * `pipeline/reprice.ts`) recomputes confidence through the EXACT same #31/#32/#60
 * bridge the full pipeline uses — never a divergent second copy that could drift the
 * publish-eligibility gate out of calibration. Pure over its inputs;
 * `autopilotEnabled` is the legacy option name and defaults to true (matching
 * `createVisionPipeline`'s run default).
 */
export function priceToConfidence(
  attributes: ExtractedAttributes,
  price: PriceResult,
  options: { autopilotEnabled?: boolean } = {},
): ConfidenceResult {
  return computeConfidence(confidenceSignalsFor(attributes, price), {
    autopilotEnabled: options.autopilotEnabled ?? true,
  });
}
