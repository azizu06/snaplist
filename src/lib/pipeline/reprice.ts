import type { ExtractedAttributes } from "./types";
import type { ConfidenceResult } from "../confidence/confidence";
import type { ItemSignal, PriceResult } from "../pricing";
import { attributesToSignal } from "./stub";
import { createDefaultPricer, priceToConfidence } from "../vision/pipeline";

/**
 * Re-price an existing item with seller-supplied discriminating specs — the engine
 * behind the "Sharpen the estimate" (clarify-variant) UX.
 *
 * The vision step already ran; the photos haven't changed. What changed is that the
 * seller told us a PRICE-DETERMINING detail we couldn't see in the photo (the exact
 * GPU, storage, generation…). Those specs NARROW the pricing search so comps cluster
 * on the SAME configuration (see `ItemSignal.specs`), which tightens comp agreement
 * and — through the SAME calibrated bridge the full pipeline uses (`priceToConfidence`)
 * — can raise confidence. It can ONLY raise it when the evidence actually improves:
 * a tighter ASKING-only cluster is still capped sub-gate (ASKING_AGREEMENT_CAP), so
 * this sharpens an honest estimate rather than inflating a number.
 *
 * Pure given an injected `priceItem` (so the seam is unit-testable offline); the
 * default is the real PriceRouter over all PRD tiers.
 */

/**
 * Upper bound on the merged spec list. The specs are a query aid fed into the search
 * agent; an unbounded list (a pasted blob, a retry loop) would bloat the query and
 * dilute the narrowing, so cap it. 12 comfortably holds a fully-specced electronics
 * item (CPU, GPU, RAM, storage, screen, gen, …) without becoming noise.
 */
export const MAX_SPECS = 12;

/**
 * Merge seller-added specs into the existing ones: existing first (stable order),
 * then new, with blanks dropped and case-insensitive duplicates removed, capped at
 * MAX_SPECS. Pure — the primary unit-test target. Trimming + case-insensitive dedupe
 * stop "RTX 3060" / " rtx 3060 " from both reaching the query as separate terms.
 */
export function mergeSpecs(
  existing: string[] | undefined,
  added: string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [...(existing ?? []), ...added]) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_SPECS) break;
  }
  return out;
}

export interface RepriceInput {
  /** The item's current extracted attributes (brand/model/category/specs/…). */
  attributes: ExtractedAttributes;
  /** The discriminating detail(s) the seller supplied to sharpen the estimate. */
  addedSpecs: string[];
  /** Master autopilot switch the run consumed (forwarded to the gate). */
  autopilotEnabled?: boolean;
  /**
   * Price an item signal. Injected in tests; defaults to the REAL PriceRouter
   * (all PRD tiers) so a production re-price runs the same routing as the upload.
   */
  priceItem?: (signal: ItemSignal) => Promise<PriceResult>;
}

export interface RepriceResult {
  /** The fresh price recommendation (suggested/range/confidence/sources/tier). */
  price: PriceResult;
  /** Confidence recomputed via the shared, calibrated `priceToConfidence` bridge. */
  confidence: ConfidenceResult;
  /** The attributes with the merged specs applied (persisted onto the item). */
  attributes: ExtractedAttributes;
  /** The merged spec list (existing + added, deduped/capped). */
  mergedSpecs: string[];
}

export async function repriceWithSpecs(
  input: RepriceInput,
): Promise<RepriceResult> {
  const mergedSpecs = mergeSpecs(input.attributes.specs, input.addedSpecs);
  const attributes: ExtractedAttributes = { ...input.attributes, specs: mergedSpecs };

  const priceItem = input.priceItem ?? createDefaultPricer();
  const signal = attributesToSignal(attributes);
  const price = await priceItem(signal);

  const confidence = priceToConfidence(attributes, price, {
    autopilotEnabled: input.autopilotEnabled,
  });

  return { price, confidence, attributes, mergedSpecs };
}
