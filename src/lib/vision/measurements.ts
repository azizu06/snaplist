import { z } from "zod";
import type { ExtractedAttributes } from "../pipeline/types";
import { resolveLanguageModel, resolveModelId } from "../llm";
import type { VisionImageInput } from "./extract";

/**
 * Garment measurements from flat-lay photos (issue #104, scoped per the PR #116
 * accuracy spike).
 *
 * The spike (`scripts/spike`) proved, on real eBay flat-lay listings scored
 * against seller-stated inches, that a vision model can estimate SOME garment
 * measurements from priors alone but NOT others:
 *
 *   pit_to_pit ~1.0in · length ~1.25in · waist ~0.5in · rise ~1.0in   ← listing-grade
 *   inseam ~4.0in · sleeve ~3.6in                                       ← unusable w/o a tape
 *
 * So the amendment (NOT the speculative original scope) is:
 *  1. per-garment-type measurement sets (this module's `GARMENT_MEASUREMENT_SETS`);
 *  2. auto-suggest ONLY the four listing-grade measurements from priors;
 *  3. REFUSE inseam/sleeve (and the other non-certified points) unless a tape
 *     measure / ruler is actually visible in the photo — never a guessed number;
 *  4. everything ships as a DRAFT the seller confirms on the review screen — never
 *     silently auto-filled into item specifics (size-class ordering was 78–80%,
 *     under the 90% bar), mirroring the confidence-gating philosophy;
 *  5. a tolerance band always rides with every value;
 *  6. capture guidance nudges the seller to lay a tape across the garment;
 *  7. the buyer-Q&A agent grounds on the seller-CONFIRMED measurements.
 *
 * Measurements are a WEAK signal: they live in `items.attributes.measurements`
 * (the established attribute surface, RLS-scoped like every other item field) and
 * are DELIBERATELY excluded from the confidence composite — they never inflate the
 * score or the autopilot gate (that stays signal-based; see `confidence/from-price`).
 * The vision call routes through the role-keyed provider registry (`vision` role),
 * exactly like `extract.ts`, and validates its output with Zod + retry.
 */

// ---------------------------------------------------------------------------
// Measurement vocabulary + per-garment-type sets (promoted from the spike).
// ---------------------------------------------------------------------------

/** The flat-lay measurement vocabulary sellers actually state (spike `types.ts`). */
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

export const measurementNameSchema = z.enum(MEASUREMENT_NAMES);

/** Human labels for the review UI and buyer-Q&A phrasing. */
export const MEASUREMENT_LABELS: Record<MeasurementName, string> = {
  pit_to_pit: "Pit to pit",
  length: "Length",
  sleeve: "Sleeve",
  shoulder: "Shoulder",
  waist: "Waist",
  inseam: "Inseam",
  rise: "Rise",
  hip: "Hip",
};

/** Underscored name → spaced words ("pit_to_pit" → "pit to pit") for prose/grounding. */
export function measurementWords(name: MeasurementName): string {
  return name.replace(/_/g, " ");
}

/** The garment classes we map measurement sets for. Two covers the hero domain
 *  (tops = tees/hoodies/sweatshirts/jackets/dresses; bottoms = jeans/pants/shorts). */
export const GARMENT_CLASSES = ["top", "bottom"] as const;
export type GarmentClass = (typeof GARMENT_CLASSES)[number];

/**
 * Which measurements are conventionally taken for each garment type, flat. The
 * review UI renders exactly this set for a garment; the vision gate never stores a
 * measurement outside its type's set.
 */
export const GARMENT_MEASUREMENT_SETS: Record<GarmentClass, readonly MeasurementName[]> = {
  top: ["pit_to_pit", "length", "shoulder", "sleeve"],
  bottom: ["waist", "rise", "inseam", "hip"],
};

/**
 * The ONLY measurements auto-suggested from priors (no reference object needed) —
 * the four that hit listing-grade median error in the spike (0.5–1.25in). Every
 * OTHER measurement needs a visible tape/ruler before we'll offer a number.
 */
export const AUTO_SUGGEST_MEASUREMENTS: readonly MeasurementName[] = [
  "pit_to_pit",
  "length",
  "waist",
  "rise",
];

/**
 * Measurements the spike showed are unusable from priors (inseam 4.0in, sleeve
 * 3.6in median error). The amendment names these two explicitly; shoulder/hip are
 * uncertified too and fall under the same "needs a reference object" rule via
 * `needsReference`. These are surfaced in the UI as "measure with a tape" prompts,
 * never a hallucinated number.
 */
export const TAPE_GATED_MEASUREMENTS: readonly MeasurementName[] = ["inseam", "sleeve"];

/** True when a measurement may only be offered with a visible reference object
 *  (i.e. it is not one of the four certified auto-suggest measurements). */
export function needsReference(name: MeasurementName): boolean {
  return !AUTO_SUGGEST_MEASUREMENTS.includes(name);
}

// ---------------------------------------------------------------------------
// Garment classification from the extracted attributes.
// ---------------------------------------------------------------------------

const TOP_KEYWORDS = [
  "shirt",
  "t-shirt",
  "tshirt",
  "tee",
  "hoodie",
  "sweatshirt",
  "sweater",
  "jumper",
  "cardigan",
  "jacket",
  "blazer",
  "coat",
  "dress",
  "blouse",
  "polo",
  "top",
  "pullover",
  "vest",
  "jersey",
];

const BOTTOM_KEYWORDS = [
  "pants",
  "pant",
  "jeans",
  "jean",
  "shorts",
  "skirt",
  "trousers",
  "trouser",
  "leggings",
  "legging",
  "capris",
  "capri",
  "chinos",
  "chino",
  "joggers",
  "jogger",
  "slacks",
  "sweatpants",
  "bottoms",
];

/** Singular "short" is ambiguous: on its own it names a pair of shorts (a bottom,
 *  e.g. "Nike Dri-FIT Short"), but as an adjective it modifies a TOP ("short trench
 *  coat", "short denim jacket", "short floral dress"). It only decides a class when
 *  no top keyword claims the text first, so it is matched LAST — plural "shorts"
 *  stays an unambiguous bottom keyword above. */
const AMBIGUOUS_BOTTOM_KEYWORDS = ["short"];

/** Sleeve-length descriptors ("short sleeve", "long-sleeved") name a top's sleeve,
 *  not a garment class — the "short" here would otherwise false-match the shorts
 *  bottom keyword. Stripped before classification so a short-sleeve top stays a top. */
const SLEEVE_DESCRIPTOR_RE = /\b(?:short|long)[\s-]*sleeve[sd]?\b/g;

/**
 * Classify free text (category / garment type / title) into a garment class, or
 * null if it isn't a garment. Sleeve-length phrases are neutralized first; then
 * unambiguous bottoms are matched, then tops, and only then the ambiguous singular
 * "short" (so an adjectival "short" on a top like "short trench coat" reads as the
 * top, while a bare "short" still reads as a bottom). All lists are word-boundary
 * matched so "topaz" or "shirtless brand" don't false-positive.
 */
export function classifyGarment(text: string | null | undefined): GarmentClass | null {
  if (!text) return null;
  const hay = text.toLowerCase().replace(SLEEVE_DESCRIPTOR_RE, " ");
  const hit = (kw: string) => new RegExp(`\\b${kw}\\b`).test(hay);
  if (BOTTOM_KEYWORDS.some(hit)) return "bottom";
  if (TOP_KEYWORDS.some(hit)) return "top";
  if (AMBIGUOUS_BOTTOM_KEYWORDS.some(hit)) return "bottom";
  return null;
}

/**
 * Decide whether an item is a garment worth measuring, and which class. Reads the
 * category first (most reliable), then the title, then brand/model text. Returns
 * null for non-garments so the pipeline skips the extra vision call entirely.
 */
export function garmentClassOf(
  attributes: Pick<ExtractedAttributes, "category" | "title" | "brand" | "model">,
): GarmentClass | null {
  return (
    classifyGarment(attributes.category) ??
    classifyGarment(attributes.title) ??
    classifyGarment(`${attributes.brand ?? ""} ${attributes.model ?? ""}`)
  );
}

/** True when the item is a garment (any class) — the pipeline's run-the-measure gate. */
export function isGarment(
  attributes: Pick<ExtractedAttributes, "category" | "title" | "brand" | "model">,
): boolean {
  return garmentClassOf(attributes) !== null;
}

// ---------------------------------------------------------------------------
// Stored draft shape + per-type Zod schema (the attribute-surface contract).
// ---------------------------------------------------------------------------

/** How the vision MODEL may self-report a measurement's derivation. */
export const measurementMethodSchema = z.enum(["reference-scaled", "prior-based"]);
export type MeasurementMethod = z.infer<typeof measurementMethodSchema>;

/**
 * The provenance PERSISTED on a draft: the model's two methods plus `seller-entered`
 * for a value the seller typed themselves. Distinct because a hand-entered number is
 * NOT scaled off an in-photo reference — collapsing it into `reference-scaled` would
 * make the review UI claim a reference that isn't there, defeating the honesty stance.
 */
export const storedMeasurementMethodSchema = z.enum([
  "reference-scaled",
  "prior-based",
  "seller-entered",
]);
export type StoredMeasurementMethod = z.infer<typeof storedMeasurementMethodSchema>;

/**
 * One measurement as PERSISTED on `items.attributes.measurements`. A draft until
 * the seller confirms it on review; `confirmed` is the only thing that lets the
 * buyer-Q&A agent state the number to a buyer (an unconfirmed AI estimate is never
 * asserted as fact — same stance as identification flagging).
 */
export const measurementDraftSchema = z.object({
  name: measurementNameSchema,
  /** Estimated (or seller-entered) measurement in inches. */
  value_in: z.number().positive(),
  /** The ± error band shown next to the value ("~21 in ± 1"). Seller-entered = 0. */
  tolerance_in: z.number().nonnegative(),
  /** How the number was derived — a visible reference, garment priors, or the seller. */
  method: storedMeasurementMethodSchema,
  /** True once the seller confirmed it on the review screen. */
  confirmed: z.boolean(),
});
export type MeasurementDraft = z.infer<typeof measurementDraftSchema>;

export const measurementDraftsSchema = z.array(measurementDraftSchema);

/**
 * The per-garment-type schema (issue #104 point 1): a measurement array where
 * every entry's `name` is valid for the given garment class. This is the contract
 * the gated vision output and the seller's saved edits must both satisfy.
 */
export function garmentMeasurementsSchema(cls: GarmentClass) {
  const allowed = new Set(GARMENT_MEASUREMENT_SETS[cls]);
  return z.array(
    measurementDraftSchema.refine((m) => allowed.has(m.name), {
      message: `measurement is not valid for a ${cls}`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Provider-facing vision response schema (adapted from the spike) + tape check.
// ---------------------------------------------------------------------------

/**
 * The ONE measurement vision call's response. Every field is required + nullable
 * (same lesson as `visionResponseSchema` in extract.ts): strict structured-output
 * modes reject `.optional()`, and "no value" must be expressible as null.
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
    .describe("What the scale reference was, if any (e.g. 'tape measure')."),
  measurements: z
    .array(
      z.object({
        name: measurementNameSchema.describe(
          "pit_to_pit = armpit-seam to armpit-seam straight across the chest; length = highest shoulder point to bottom hem; sleeve = shoulder seam to cuff; waist = straight across the waistband flat, NOT doubled; inseam = crotch seam to leg hem; rise = crotch seam to top of waistband; hip/shoulder as conventionally measured flat.",
        ),
        value_in: z.number().describe("Estimated measurement in inches."),
        tolerance_in: z
          .number()
          .describe("Honest ± error band in inches. Be blunt when guessing."),
        method: measurementMethodSchema.describe(
          "reference-scaled = derived from a visible known-size object; prior-based = estimated from garment type, size tag, and proportions only.",
        ),
      }),
    )
    .nullable(),
});
export type MeasurementResponse = z.infer<typeof measurementResponseSchema>;

/** Reference kinds that count as a real length scale for the tape gate. A credit
 *  card / paper can scale a photo, but the amendment's tape prompt is specifically
 *  a tape/ruler laid across the garment — those are what unlock inseam/sleeve. */
const TAPE_KINDS_RE = /tape|ruler|measur|yard\s*stick|meter\s*stick|metre\s*stick/i;

/**
 * Did the photo actually contain a usable length reference? Requires BOTH the
 * model's boolean AND a tape/ruler-like kind — a bare `scaleReferenceFound: true`
 * with no nameable reference isn't trusted to unlock the tape-gated measurements.
 */
export function tapeVisible(res: Pick<MeasurementResponse, "scaleReferenceFound" | "scaleReferenceKind">): boolean {
  return res.scaleReferenceFound === true && TAPE_KINDS_RE.test(res.scaleReferenceKind ?? "");
}

// ---------------------------------------------------------------------------
// The gate: raw model output → the DRAFTS we actually store.
// ---------------------------------------------------------------------------

/**
 * Apply the amendment's policy to a raw measurement response, yielding the drafts
 * we persist (all `confirmed: false`):
 *
 *  - drop anything outside the garment type's set;
 *  - the four certified measurements (pit_to_pit/length/waist/rise) are kept from
 *    priors alone;
 *  - every other measurement (inseam, sleeve, shoulder, hip) is kept ONLY when a
 *    tape/ruler is visible — otherwise it is REFUSED (never a guessed number);
 *  - non-finite/non-positive values are dropped defensively.
 *
 * Pure and deterministic → unit-tested directly.
 */
export function gateMeasurements(
  res: MeasurementResponse,
  cls: GarmentClass,
): MeasurementDraft[] {
  const allowed = new Set(GARMENT_MEASUREMENT_SETS[cls]);
  const tape = tapeVisible(res);
  const out: MeasurementDraft[] = [];
  const seen = new Set<MeasurementName>();
  for (const m of res.measurements ?? []) {
    if (!allowed.has(m.name) || seen.has(m.name)) continue;
    if (needsReference(m.name) && !tape) continue; // REFUSE — no tape, no guess
    if (!Number.isFinite(m.value_in) || m.value_in <= 0) continue;
    seen.add(m.name);
    const modelTolerance =
      Number.isFinite(m.tolerance_in) && m.tolerance_in > 0 ? m.tolerance_in : 1;
    // Without a visible tape EVERY kept measurement is a prior-based estimate — the
    // model's own `method`/`tolerance_in` are not trusted to claim reference-scaled
    // precision (or a sub-inch band) it cannot ground, which would show the seller
    // false precision. Force prior-based and floor the band to ±1in.
    out.push({
      name: m.name,
      value_in: m.value_in,
      tolerance_in: tape ? modelTolerance : Math.max(modelTolerance, 1),
      method: tape ? m.method : "prior-based",
      confirmed: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Seller edits (review screen) → confirmed drafts. Pure, unit-tested.
// ---------------------------------------------------------------------------

/** One measurement field as submitted by the review form. */
export interface SubmittedMeasurement {
  name: MeasurementName;
  /** The value text from the input ("" clears the measurement). */
  value: string;
  /** Whether the seller ticked this measurement's confirm box. */
  confirmed: boolean;
}

/**
 * Merge the review form's measurement edits over the existing drafts. Blank clears
 * a measurement; a seller-typed/edited value is treated as hand-measured (exact →
 * tolerance 0, method seller-entered — NOT reference-scaled, since no in-photo
 * reference is implied); an untouched vision draft keeps its model tolerance +
 * method. Junk throws (a typo must never silently wipe a measurement). Values
 * outside the garment's set are ignored.
 */
export function parseMeasurementEdits(
  existing: MeasurementDraft[],
  submitted: SubmittedMeasurement[],
  cls: GarmentClass,
): MeasurementDraft[] {
  const allowed = new Set(GARMENT_MEASUREMENT_SETS[cls]);
  const prior = new Map(existing.map((m) => [m.name, m]));
  const out: MeasurementDraft[] = [];
  const seen = new Set<MeasurementName>();
  for (const s of submitted) {
    if (!allowed.has(s.name) || seen.has(s.name)) continue;
    const raw = s.value.trim();
    if (raw === "") continue; // blank = clear this measurement
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(
        `Enter a positive number of inches for ${MEASUREMENT_LABELS[s.name]} (or leave it blank).`,
      );
    }
    seen.add(s.name);
    const before = prior.get(s.name);
    const edited = !before || trimInches(before.value_in) !== trimInches(value);
    out.push({
      name: s.name,
      value_in: value,
      tolerance_in: edited ? 0 : before!.tolerance_in,
      method: edited ? "seller-entered" : before!.method,
      confirmed: s.confirmed,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Display + buyer-Q&A grounding helpers (pure).
// ---------------------------------------------------------------------------

/** Trim a measurement number for display ("21.0" → "21", "21.50" → "21.5"). */
export function trimInches(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(2)));
}

/** "~21 in ± 1" — the value with its always-shown tolerance band. Tolerance 0
 *  (a seller-measured value) drops the band entirely. */
export function formatMeasurement(value: number, toleranceIn: number): string {
  const base = `${trimInches(value)} in`;
  return toleranceIn > 0 ? `~${base} ± ${trimInches(toleranceIn)}` : base;
}

/**
 * Phrases the buyer-Q&A agent may ground a reply in — one per CONFIRMED
 * measurement ("pit to pit 21"). Unconfirmed drafts are excluded: the agent must
 * never assert an estimate the seller hasn't vouched for. The phrasing puts the
 * measurement name beside the number — and NO unit word — so the reply agent's
 * numeric guard binds the value only to that measurement's own name tokens. A
 * trailing "inches" would sit in every measurement's (and every sizing reply's)
 * context window, letting one measurement's number launder into another's claim.
 */
export function confirmedMeasurementPhrases(
  measurements: MeasurementDraft[] | undefined,
): string[] {
  if (!measurements) return [];
  return measurements
    .filter((m) => m.confirmed)
    .map((m) => `${measurementWords(m.name)} ${trimInches(m.value_in)}`);
}

// ---------------------------------------------------------------------------
// The measurement vision call (routes through the `vision` registry role).
// ---------------------------------------------------------------------------

/** The injectable measurement model call — a single multimodal request over the
 *  garment photos. Tests pass a fake; the default is the real lazy wrapper. */
export type MeasureGenerate = (args: {
  model: string;
  images: VisionImageInput[];
  garmentType: string;
  attempt: number;
}) => Promise<MeasurementResponse>;

export interface ExtractGarmentMeasurementsInput {
  images: VisionImageInput[];
  /** The garment class (drives which measurements are valid). */
  garmentClass: GarmentClass;
  /** Free-text garment type for the prompt (e.g. "hoodie"); optional. */
  garmentType?: string;
  /** Injected model call (defaults to the real lazy wrapper). */
  generate?: MeasureGenerate;
  /** Model id override (else `VISION_MODEL` env / provider default). */
  model?: string;
  /** Schema-mismatch retries before giving up. Default 1 (→ up to 2 attempts). */
  maxRetries?: number;
}

export interface ExtractGarmentMeasurementsResult {
  /** The GATED drafts (auto-suggest kept, tape-gated dropped without a tape). */
  measurements: MeasurementDraft[];
  /** Whether a usable tape/ruler was detected (surfaced to the review UI). */
  tapeDetected: boolean;
  /** The model's read of the garment type, if any. */
  garmentType: string | null;
  /** The model id used (logged for provenance). */
  model: string;
}

const MEASURE_SYSTEM_PROMPT =
  "You estimate the flat-lay measurements of a secondhand garment from photos, the " +
  "way a reseller would with a tape measure. First look for any object of KNOWN " +
  "physical size in the frame — a tape measure or ruler (read it directly where it " +
  "crosses the garment), a credit card (3.37in wide), letter paper (8.5x11in), a coin, " +
  "a phone. If one exists, derive a pixels-per-inch scale from it and measure the " +
  "garment against that scale; report those measurements with method=reference-scaled " +
  "and name the reference in scaleReferenceKind. If NO known-size object is visible, " +
  "estimate from garment-type proportions and any visible size tag (a men's size-L tee " +
  "is typically ~22in pit-to-pit) and report method=prior-based. Only report " +
  "measurements you can actually ground in the photo; use standard flat-lay " +
  "conventions (waist measured FLAT across, not doubled). Be brutally honest in " +
  "tolerance_in: a reference-scaled reading might be ±0.5in, a pure prior-based guess " +
  "is often ±2in or worse — say so.";

function resolveModel(model?: string): string {
  return resolveModelId("vision", { modelId: model });
}

/**
 * Run the single measurement vision call for a garment, validate + retry on schema
 * mismatch, then GATE the result. Never throws for "no measurements" — a garment we
 * can't measure simply yields an empty draft list; only an exhausted retry loop of
 * hard model failures rejects. Callers (the pipeline) treat any rejection as
 * best-effort (measurements are auxiliary, never on the critical path).
 */
export async function extractGarmentMeasurements(
  input: ExtractGarmentMeasurementsInput,
): Promise<ExtractGarmentMeasurementsResult> {
  const { images, garmentClass, maxRetries = 1 } = input;
  if (images.length === 0) {
    throw new Error("Garment measurement requires at least one image.");
  }
  const model = resolveModel(input.model);
  const generate = input.generate ?? createGarmentMeasureGenerate();
  const garmentType = input.garmentType ?? garmentClass;

  const attempts = maxRetries + 1;
  let lastIssues = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    let raw: MeasurementResponse;
    try {
      raw = await generate({ model, images, garmentType, attempt });
    } catch (err) {
      lastIssues = err instanceof Error ? err.message : String(err);
      continue;
    }
    const parsed = measurementResponseSchema.safeParse(raw);
    if (parsed.success) {
      return {
        measurements: gateMeasurements(parsed.data, garmentClass),
        tapeDetected: tapeVisible(parsed.data),
        garmentType: parsed.data.garmentType,
        model,
      };
    }
    lastIssues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }
  throw new Error(
    `Garment measurement did not produce a schema-valid response after ${attempts} attempt(s). ` +
      `Last errors: ${lastIssues}`,
  );
}

/**
 * The real measurement generate: a lazy wrapper around the AI SDK's `generateObject`
 * with `schema: measurementResponseSchema`, resolving the model through the `vision`
 * registry role (provider-aware; NEVER a provider constructed inline). Imported
 * lazily so the offline test path never loads the SDK. Nulls in the response are
 * left as-is — the gate and `tapeVisible` handle null fields.
 */
export function createGarmentMeasureGenerate(
  apiKey: string | undefined = undefined,
): MeasureGenerate {
  return async ({ model, images, garmentType, attempt }) => {
    const { generateObject } = await import("ai");
    const llmModel = await resolveLanguageModel("vision", { modelId: model, apiKey });

    const imageParts = images.map((img) =>
      typeof img === "string"
        ? ({ type: "image" as const, image: img })
        : ({ type: "image" as const, image: img.data, mediaType: img.mediaType }),
    );
    const instruction =
      (attempt === 0
        ? `Estimate this ${garmentType}'s flat-lay measurements in inches.`
        : "Your previous response was not schema-valid. Re-estimate, strictly matching the schema.") +
      (images.length > 1 ? " All photos show the SAME garment (different angles or close-ups)." : "");

    const { object } = await generateObject({
      model: llmModel,
      schema: measurementResponseSchema,
      system: MEASURE_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: instruction }, ...imageParts],
        },
      ],
    });
    return object as MeasurementResponse;
  };
}
