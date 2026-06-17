import { z } from "zod";

/**
 * Clarifying-options schemas (the "Sharpen the estimate" generator, sibling to the
 * reprice consumer in `pipeline/reprice.ts`).
 *
 * The vision step identifies what it CAN see; this generator proposes a short,
 * DYNAMIC, per-product list of details it CANNOT see but that move the price or
 * listing quality — for the seller to confirm. Each confirmed option contributes a
 * `spec` that flows through the existing `repriceWithSpecs(addedSpecs)` path, so no
 * new pricing route is introduced. This is the honest-grounded-copy rule as a UI
 * affordance: the model ASKS rather than asserting facts it can't verify.
 *
 * Two schema flavours (mirroring `listing/schema.ts`):
 *  - RAW (`clarifyingOptionsRawSchema`) — permissive, handed to `generateObject` and
 *    registered as this role's output contract; the model's response validates here.
 *  - CLEAN (`clarifyingOptionsSchema`) — the post-refinement shape the UI consumes
 *    (non-empty label + spec), after dedupe / known-attribute / cap filtering.
 */

/** A single option the seller can toggle on if it's true of THEIR specific item. */
export const clarifyingOptionRawSchema = z.object({
  /** Plain, seller-facing chip text, e.g. "Webcam privacy shutter works". */
  label: z.string(),
  /** Concise search/listing term added when confirmed, e.g. "privacy shutter functional". */
  spec: z.string(),
});

/** The RAW model output: the SAME schema handed to `generateObject` for this role. */
export const clarifyingOptionsRawSchema = z.object({
  options: z.array(clarifyingOptionRawSchema),
});
export type RawClarifyingOptions = z.infer<typeof clarifyingOptionsRawSchema>;
export type RawClarifyingOption = z.infer<typeof clarifyingOptionRawSchema>;

/** A refined, UI-ready option: both fields guaranteed non-empty. */
export const clarifyingOptionSchema = z.object({
  label: z.string().min(1),
  spec: z.string().min(1),
});
export type ClarifyingOption = z.infer<typeof clarifyingOptionSchema>;

export const clarifyingOptionsSchema = z.object({
  options: z.array(clarifyingOptionSchema),
});

/**
 * Cap on options shown. Few, high-value confirmations beat a wall of checkboxes —
 * the point is to make the seller think "oh yeah, that matters", not to interrogate
 * them. 6 comfortably covers the discriminating details of a hero-domain item.
 */
export const MAX_CLARIFYING_OPTIONS = 6;
