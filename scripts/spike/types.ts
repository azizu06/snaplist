import { z } from "zod";

/**
 * Spike #104 — shared types for the garment-measurement accuracy experiment.
 *
 * This is throwaway experiment code (lives entirely under scripts/spike/), but the
 * gold fixture format and the model's output contract are pinned with Zod so the
 * harness fails loudly on malformed data instead of producing a garbage verdict.
 */

/** The measurement vocabulary sellers actually use for flat-lay garment specs. */
export const MEASUREMENT_NAMES = [
  "pit_to_pit",
  "length",
  "sleeve",
  "shoulder",
  "waist",
  "inseam",
  "rise",
  "hip",
] as const;
export type MeasurementName = (typeof MEASUREMENT_NAMES)[number];

const measurementName = z.enum(MEASUREMENT_NAMES);

/** One gold fixture: a real listing whose seller stated the measurements. */
export const goldFixtureSchema = z.object({
  id: z.string().min(1),
  listing_url: z.string().url(),
  image_url: z.string().url(),
  garment_type: z.string().min(1),
  size_label: z.string().nullable(),
  scale_cue: z.boolean(),
  scale_cue_kind: z.string().nullable(),
  /**
   * Additional photos (tape close-ups, full flat-lay) when one photo can't ground
   * every stated measurement. Sellers really do shoot multiple angles, and the
   * product's vision call accepts 1–4 images — the spike mirrors that.
   */
  extra_image_urls: z.array(z.string().url()).max(3).optional(),
  /** Seller-stated inches, keyed by measurement name. Ground truth (±~0.5in noise). */
  measurements: z.partialRecord(measurementName, z.number().positive()),
  measurement_source: z.string(),
  notes: z.string().optional(),
});
export type GoldFixture = z.infer<typeof goldFixtureSchema>;

export const goldFixturesSchema = z.array(goldFixtureSchema).min(1);

/**
 * Provider-facing response schema for the ONE vision call per fixture.
 * Every field required + nullable (not .optional()) — same lesson as
 * `visionResponseSchema` in src/lib/vision/extract.ts: strict structured-output
 * modes reject optional keys, and "no value" must be expressible as null.
 */
export const measurementResponseSchema = z.object({
  garmentType: z
    .string()
    .nullable()
    .describe("What the garment is, e.g. tshirt, hoodie, jacket, jeans."),
  scaleReferenceFound: z
    .boolean()
    .nullable()
    .describe(
      "True if a known-size object (tape measure, ruler, credit card, letter paper) is visible and was used for scale.",
    ),
  scaleReferenceKind: z
    .string()
    .nullable()
    .describe("What the scale reference was, if any."),
  measurements: z
    .array(
      z.object({
        name: measurementName.describe(
          "pit_to_pit = armpit-seam to armpit-seam straight across the chest; length = highest shoulder point (or collar base) to bottom hem; sleeve = shoulder seam to cuff; waist = straight across the waistband (flat, NOT doubled); inseam = crotch seam to leg hem; rise = crotch seam to top of waistband; hip/shoulder as conventionally measured flat.",
        ),
        value_in: z.number().describe("Estimated measurement in inches."),
        tolerance_in: z
          .number()
          .describe("Your honest ± error band in inches. Be blunt when guessing."),
        method: z
          .enum(["reference-scaled", "prior-based"])
          .describe(
            "reference-scaled = derived from a visible known-size object; prior-based = estimated from garment type, visible size tag, and proportions only.",
          ),
      }),
    )
    .nullable(),
});
export type MeasurementResponse = z.infer<typeof measurementResponseSchema>;

/** One fixture's recorded model run (persisted to predictions.json). */
export const predictionRecordSchema = z.object({
  fixtureId: z.string().min(1),
  model: z.string(),
  ok: z.boolean(),
  /** Set when ok=false — the call or validation failed for this fixture. */
  error: z.string().optional(),
  response: measurementResponseSchema.optional(),
});
export type PredictionRecord = z.infer<typeof predictionRecordSchema>;

/** predictions.json is an array of these — parsed (not cast) so bad data fails loudly. */
export const predictionRecordsSchema = z.array(predictionRecordSchema);
