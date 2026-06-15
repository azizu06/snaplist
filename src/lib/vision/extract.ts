import { z } from "zod";
import {
  extractedAttributesSchema,
  type ExtractedAttributes,
  type Identification,
} from "../pipeline/types";
import { resolveLanguageModel, resolveModelId } from "../llm";

/**
 * Real single-shot multimodal vision extraction (issue #6).
 *
 * Given 1–4 images, ONE multimodal model call extracts structured attributes +
 * condition + barcode/ISBN/UPC, Zod-validated against `extractedAttributesSchema`
 * (the attribute contract). Invalid output is retried; persistent invalid output
 * throws. Mirrors `rag/embedding.ts`: the SDK is imported LAZILY and the provider
 * is env-keyed, so this module (and the offline test path) never touches the
 * network unless the real `generate` actually runs.
 *
 * AGENTS.md: "OpenAI via the Vercel AI SDK … structured output via `generateObject`
 * + Zod — no ad-hoc JSON parsing." PRD: "All provided images fed to a SINGLE
 * structured-extraction vision call → attributes + condition + barcode/ISBN."
 *
 * The model call is INJECTED (`generate`) so tests run fully offline and can script
 * invalid-then-valid sequences to exercise the retry path.
 */

/** Min/max images the single call accepts (PRD: 1 required, up to ~4). */
export const MIN_IMAGES = 1;
export const MAX_IMAGES = 4;

/**
 * Current strong multimodal model (confirmed against OpenAI docs at build time —
 * gpt-5.5 is the latest flagship, supports vision + structured outputs). Overridable
 * via `VISION_MODEL` so the provider/model stays swappable (AGENTS.md: env-configurable
 * everything; PRD: "Exact model IDs confirmed against current OpenAI docs at build time").
 */
export const DEFAULT_VISION_MODEL = "gpt-5.5";

/**
 * One image fed to the vision call. Either a URL string (e.g. a signed Storage URL)
 * or inline bytes with their media type. The pipeline resolves Storage paths to
 * signed URLs (see `photos.ts`) before calling here.
 */
export type VisionImageInput = string | { data: string | Uint8Array; mediaType: string };

/**
 * The raw object a vision call yields. A SUPERSET of the attribute schema: the model
 * may additionally signal its own uncertainty (`ambiguous` / `uncertaintyReason`) and
 * propose `candidates`. Only the attribute fields are validated against the schema;
 * the uncertainty hints feed identification flagging (never confidence — that stays
 * signal-based). Indexable so a fake/model can return extra keys without a type error.
 */
export type VisionGenerateResult = Partial<ExtractedAttributes> & {
  /** The model's own "I'm not sure" flag, if it chose to raise one. */
  ambiguous?: boolean;
  /** Why the model is unsure (surfaced to the user when present). */
  uncertaintyReason?: string;
  /** Plausible alternative identities the model considered. */
  candidates?: string[];
  [key: string]: unknown;
};

/** The injectable model call: a single multimodal request over ALL images. */
export type VisionGenerate = (args: {
  /** The vision-capable model id. */
  model: string;
  /** Every provided image, fed together to a SINGLE call. */
  images: VisionImageInput[];
  /** Which attempt this is (0-based) — lets the real wrapper nudge the prompt on retry. */
  attempt: number;
}) => Promise<VisionGenerateResult>;

export interface ExtractItemAttributesInput {
  /** 1–4 image inputs (URLs and/or inline bytes). Enforced; 0 or >4 throws. */
  images: VisionImageInput[];
  /** Injected model call. Defaults to the real lazy `generateObject` wrapper. */
  generate?: VisionGenerate;
  /** Schema-mismatch retries before throwing. Default 2 (→ up to 3 attempts). */
  maxRetries?: number;
  /** Model id override (else `VISION_MODEL` env, else `DEFAULT_VISION_MODEL`). */
  model?: string;
}

export interface ExtractItemAttributesResult {
  /** Zod-validated structured attributes (the contract output). */
  attributes: ExtractedAttributes;
  /** "What we think it is", with ambiguity flagged — surfaced before pricing. */
  identification: Identification;
  /** The model id used (logged for evaluation). */
  model: string;
}

// ---------------------------------------------------------------------------
// Identification: derived from STRONG identifiers + the model's uncertainty hint.
// Never a fabricated confident id from thin evidence (issue #6 + AGENTS non-negotiable).
// ---------------------------------------------------------------------------

/**
 * Fraction of the four strong identifiers that resolved, in [0,1]. Mirrors the
 * confidence composite's identification booleans (brand, model, decoded
 * barcode/ISBN/UPC, an unambiguous category) so "what we think it is" and the
 * downstream confidence score read the SAME evidence.
 */
export function identificationEvidence(attrs: ExtractedAttributes): number {
  let resolved = 0;
  if (attrs.brand) resolved += 1;
  if (attrs.model) resolved += 1;
  if (attrs.upc || attrs.isbn) resolved += 1;
  if (attrs.category) resolved += 1;
  return resolved / 4;
}

/** A readable label for "what we think it is", best-effort from the resolved fields. */
function deriveLabel(attrs: ExtractedAttributes): string {
  if (attrs.title) return attrs.title;
  const parts = [attrs.brand, attrs.model].filter(Boolean);
  if (parts.length > 0) return parts.join(" ");
  if (attrs.category) return `Unidentified ${attrs.category} item`;
  return "Unidentified item";
}

/**
 * Threshold of resolved strong-identifier evidence required to be "confident".
 * 0.5 == at least two of {brand, model, barcode, category} — enough to price the
 * hero domain; below it we flag for confirmation rather than guess.
 */
const CONFIDENT_EVIDENCE_MIN = 0.5;

/**
 * Build the identification from validated attributes + the model's optional
 * uncertainty hint. `confident` requires BOTH enough strong evidence AND the model
 * not raising its own ambiguity flag — either alone defeats it. We never invent a
 * confident id from a bare category/title.
 */
export function deriveIdentification(
  attrs: ExtractedAttributes,
  raw: VisionGenerateResult,
): Identification {
  const evidence = identificationEvidence(attrs);
  const label = deriveLabel(attrs);
  const modelUnsure = raw.ambiguous === true;
  const enoughEvidence = evidence >= CONFIDENT_EVIDENCE_MIN;
  const confident = enoughEvidence && !modelUnsure;

  const candidates =
    Array.isArray(raw.candidates) && raw.candidates.length > 0
      ? raw.candidates.filter((c): c is string => typeof c === "string")
      : undefined;

  if (confident) {
    return { label, confident: true, evidence, candidates };
  }

  // Flag, with an honest reason: the model's own words if it gave them, else
  // a derived "not enough to identify" message.
  const reason =
    (typeof raw.uncertaintyReason === "string" && raw.uncertaintyReason) ||
    (modelUnsure
      ? "Model flagged this identification as uncertain."
      : "Not enough strong identifiers (brand, model, barcode, or unambiguous category) to confirm the item.");

  return {
    label,
    confident: false,
    evidence,
    reason,
    candidates,
  };
}

// ---------------------------------------------------------------------------
// The extraction entrypoint
// ---------------------------------------------------------------------------

function resolveModel(model?: string): string {
  return resolveModelId("vision", { modelId: model });
}

/**
 * Run the single multimodal extraction. Enforces the 1..4 image bound, calls
 * `generate` once per attempt, validates each candidate against the attribute
 * schema, retries on mismatch up to `maxRetries`, and throws a clear error after
 * exhaustion. Returns the validated attributes + a flagged identification.
 */
export async function extractItemAttributes(
  input: ExtractItemAttributesInput,
): Promise<ExtractItemAttributesResult> {
  const { images, maxRetries = 2 } = input;

  if (images.length < MIN_IMAGES) {
    throw new Error(
      `Vision extraction requires at least ${MIN_IMAGES} image; received ${images.length}.`,
    );
  }
  if (images.length > MAX_IMAGES) {
    throw new Error(
      `Vision extraction accepts up to ${MAX_IMAGES} images; received ${images.length}.`,
    );
  }

  const model = resolveModel(input.model);
  const generate = input.generate ?? createOpenAIVisionGenerate();

  const attempts = maxRetries + 1;
  let lastIssues = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    let raw: VisionGenerateResult;
    try {
      raw = await generate({ model, images, attempt });
    } catch (err) {
      // The real `generateObject` validates internally and THROWS
      // (NoObjectGeneratedError) on a parse/schema failure rather than returning an
      // invalid object. A throw here is a FAILED ATTEMPT, not a fatal error — record
      // it and retry; only give up once all attempts are exhausted. (Without this
      // catch the first invalid real response would bypass `maxRetries` entirely.)
      lastIssues = err instanceof Error ? err.message : String(err);
      continue;
    }
    const parsed = extractedAttributesSchema.safeParse(raw);
    if (parsed.success) {
      const attributes = parsed.data;
      return {
        attributes,
        identification: deriveIdentification(attributes, raw),
        model,
      };
    }
    lastIssues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
  }

  throw new Error(
    `Vision extraction did not produce schema-valid attributes after ${attempts} attempt(s). ` +
      `Last validation errors: ${lastIssues}`,
  );
}

// ---------------------------------------------------------------------------
// Real OpenAI vision generate (via the Vercel AI SDK) — lazy, key-gated.
// Used only when no `generate` is injected. Never imported by the offline tests.
// ---------------------------------------------------------------------------

/**
 * The schema handed to `generateObject` on the real path. A SUPERSET of the
 * attribute contract: it adds the model's self-reported uncertainty signals so they
 * survive structured decoding (a bare `extractedAttributesSchema` would strip them).
 *
 * OpenAI structured outputs (strict) require EVERY property to be present in
 * `required` and express "no value" as `null` — an `.optional()` key is rejected
 * (NoObjectGeneratedError). So the provider-facing schema declares every field
 * REQUIRED + `.nullable()`; `nullsToUndefined` maps nulls back to `undefined` before
 * returning, and `extractItemAttributes` re-validates the attribute SUBSET against
 * the canonical (optional) `extractedAttributesSchema`. The contract is still the
 * gate; this just makes the single real call actually succeed and lets the model
 * also TELL us when it's unsure.
 */
export const visionResponseSchema = z.object({
  brand: z.string().nullable(),
  model: z.string().nullable(),
  category: z.string().nullable(),
  condition: z
    .string()
    .nullable()
    .describe("Assessed wear state, e.g. new / like-new / good / fair."),
  isbn: z
    .string()
    .nullable()
    .describe("Decoded ISBN read from the image (books/media), else null."),
  upc: z.string().nullable().describe("Decoded UPC read from the image, else null."),
  specs: z.array(z.string()).nullable().describe("Key specs visible on the item."),
  title: z.string().nullable().describe("A short human title for the item."),
  ambiguous: z
    .boolean()
    .nullable()
    .describe("True if you cannot confidently identify the item from the photos."),
  uncertaintyReason: z
    .string()
    .nullable()
    .describe("Short reason you are unsure (e.g. blurry photo, no visible brand)."),
  candidates: z
    .array(z.string())
    .nullable()
    .describe("Plausible alternative identities when unsure, instead of guessing one."),
});

/**
 * Normalize provider `null`s → `undefined` so the optional attribute contract
 * (`extractedAttributesSchema`) validates cleanly and the identification hints read
 * as absent rather than literal null.
 */
function nullsToUndefined(obj: Record<string, unknown>): VisionGenerateResult {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v === null ? undefined : v;
  return out as VisionGenerateResult;
}

/** System guidance: extract faithfully, READ barcodes visually, and flag uncertainty. */
const EXTRACTION_SYSTEM_PROMPT =
  "You identify a used item for resale from one or more photos. Extract only what you can " +
  "actually see: brand, model, category, condition, and any decoded barcode (ISBN for books/media, " +
  "UPC otherwise) read directly from the image. Provide key specs and a short title. " +
  "Do NOT guess a brand or model you cannot confirm from the photos — if the item is ambiguous, " +
  "generic, or the photo is unclear, set ambiguous=true, give a short uncertaintyReason, and list " +
  "any plausible candidates instead of committing to one identity.";

/**
 * Build the real generate: a lazy wrapper around the AI SDK's `generateObject` with
 * `schema: extractedAttributesSchema`, passing ALL images as image parts in a SINGLE
 * user message. Imported lazily (like `embedding.ts`) so the SDK never loads on the
 * offline test path. `apiKey` defaults to OPENAI_API_KEY.
 */
export function createOpenAIVisionGenerate(
  apiKey: string | undefined = undefined,
): VisionGenerate {
  return async ({ model, images, attempt }) => {
    const { generateObject } = await import("ai");
    const llmModel = await resolveLanguageModel("vision", { modelId: model, apiKey });

    // One user message: instruction text + N image parts → a SINGLE multimodal call.
    const imageParts = images.map((img) =>
      typeof img === "string"
        ? ({ type: "image" as const, image: img })
        : ({ type: "image" as const, image: img.data, mediaType: img.mediaType }),
    );
    const instruction =
      attempt === 0
        ? "Identify this item and extract its attributes from the photo(s)."
        : "Your previous response was not valid. Re-extract, strictly matching the schema.";

    const { object } = await generateObject({
      model: llmModel,
      schema: visionResponseSchema,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: instruction }, ...imageParts],
        },
      ],
    });
    return nullsToUndefined(object as Record<string, unknown>);
  };
}
