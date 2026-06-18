import { resolveLanguageModel, resolveModelId } from "../llm";
import type { ExtractedAttributes } from "../pipeline/types";
import {
  MAX_CLARIFYING_OPTIONS,
  clarifyingOptionsRawSchema,
  type ClarifyingOption,
  type RawClarifyingOption,
  type RawClarifyingOptions,
} from "./schema";

/**
 * Generate DYNAMIC, per-product clarifying options for the "Sharpen the estimate"
 * UX. Given the item's extracted attributes, an LLM proposes a short list of details
 * the seller can confirm that the PHOTO can't reveal but that move the price/listing
 * (e.g. a laptop: "Webcam privacy shutter works", "Charger included", "Battery health
 * tested good"; headphones: "Original case included", "Noise-cancelling tested
 * working"). Confirmed options become `addedSpecs` for the existing reprice consumer.
 *
 * Mirrors `listing/generate.ts`: the model call is INJECTED (`generate`, default a
 * lazy `generateObject` wrapper) so tests run fully offline, the model is resolved
 * through the role-keyed registry (`resolveLanguageModel("clarify", …)`), and the
 * raw output is deterministically REFINED before the UI sees it.
 */

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Deterministically refine raw model options into the UI-ready set. Pure — the
 * primary unit-test target. Rules, in order:
 *  - both `label` and `spec` are required (drop blanks);
 *  - never re-ask a detail already in the attributes (specs / brand / model) —
 *    that's noise, the seller already gave it;
 *  - dedupe case-insensitively by BOTH label and spec (a model often restates the
 *    same idea two ways);
 *  - cap at `max` so the seller sees a focused, high-value set, not a checklist.
 */
export function refineClarifyingOptions(
  raw: readonly Partial<RawClarifyingOption>[],
  attributes: ExtractedAttributes,
  max: number = MAX_CLARIFYING_OPTIONS,
): ClarifyingOption[] {
  const known = new Set<string>();
  for (const s of attributes.specs ?? []) known.add(norm(s));
  if (attributes.brand) known.add(norm(attributes.brand));
  if (attributes.model) known.add(norm(attributes.model));

  const out: ClarifyingOption[] = [];
  const seenLabel = new Set<string>();
  const seenSpec = new Set<string>();
  for (const o of raw) {
    const label = (o.label ?? "").trim();
    const spec = (o.spec ?? "").trim();
    if (!label || !spec) continue;
    const lk = norm(label);
    const sk = norm(spec);
    if (known.has(sk)) continue; // already known — don't ask it again
    if (seenLabel.has(lk) || seenSpec.has(sk)) continue;
    seenLabel.add(lk);
    seenSpec.add(sk);
    out.push({ label, spec });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Injectable model call: attributes in, raw options out. The real wrapper drives
 * `generateObject` with `clarifyingOptionsRawSchema`; tests pass a fake.
 */
export type ClarifyGenerate = (args: {
  model: string;
  attributes: ExtractedAttributes;
}) => Promise<RawClarifyingOptions>;

export interface GenerateClarifyingOptionsInput {
  /** The item's extracted attributes — the basis for what to ask about. */
  attributes: ExtractedAttributes;
  /** Injected model call. Defaults to the real lazy `generateObject` wrapper. */
  generate?: ClarifyGenerate;
  /** Model id override (else `CLARIFY_MODEL` env, else the role default). */
  model?: string;
  /** Cap on returned options. Default `MAX_CLARIFYING_OPTIONS`. */
  maxOptions?: number;
}

export interface GenerateClarifyingOptionsResult {
  /** The refined, UI-ready options (may be empty). */
  options: ClarifyingOption[];
  /** The model id used (logged for evaluation). */
  model: string;
}

/**
 * Generate refined clarifying options for an item.
 *
 * BEST-EFFORT BY DESIGN: clarifying options are a sharpening aid, not core pricing.
 * If generation fails (model error / bad output), we return ZERO options rather than
 * erroring — the seller falls back to the free-text detail field and the review page
 * still renders. This is a deliberate graceful-degradation, not a swallowed bug: the
 * caller logs the failure (it has the request context) while the seller is unblocked.
 */
export async function generateClarifyingOptions(
  input: GenerateClarifyingOptionsInput,
): Promise<GenerateClarifyingOptionsResult> {
  const model = resolveModelId("clarify", { modelId: input.model });
  const generate = input.generate ?? createOpenAIClarifyGenerate();

  let raw: RawClarifyingOptions;
  try {
    raw = await generate({ model, attributes: input.attributes });
  } catch {
    raw = { options: [] };
  }

  const options = refineClarifyingOptions(
    raw.options,
    input.attributes,
    input.maxOptions ?? MAX_CLARIFYING_OPTIONS,
  );
  return { options, model };
}

/**
 * System guidance: ASK the seller about price-moving details the photo can't show.
 * This is the honest-grounded-copy rule made generative — the model proposes
 * questions, it does not assert unverifiable facts or prices.
 */
const CLARIFY_SYSTEM_PROMPT =
  "You help a seller sharpen the price of a USED item. Given the item's known " +
  "attributes, produce a SHORT list (at most 6) of clarifying options the seller can " +
  "CONFIRM — each a detail that (a) CANNOT be determined from a photo and (b) " +
  "materially affects resale price or listing quality. Phrase each `label` as a plain " +
  "thing the seller toggles on if it is TRUE of their specific item (e.g. 'Charger " +
  "included', 'Webcam privacy shutter works', 'Original box included', 'Battery health " +
  "tested good'). Give a concise `spec`: the search/listing term to add when confirmed " +
  "(e.g. 'with charger', 'privacy shutter functional'). Tailor every option to THIS " +
  "product — a laptop's options differ from headphones' or a board game's. Never " +
  "include anything already present in the attributes. Never assert a price, and never " +
  "claim a condition you cannot see — you are ASKING the seller, not stating facts.";

/**
 * Build the real generate: a lazy `generateObject` wrapper (imported lazily so the AI
 * SDK never loads on the offline test path). The model resolves through the registry
 * (`resolveLanguageModel("clarify", …)`), so the provider/key follow `LLM_PROVIDER`.
 */
export function createOpenAIClarifyGenerate(
  apiKey: string | undefined = undefined,
): ClarifyGenerate {
  return async ({ model, attributes }) => {
    const { generateObject } = await import("ai");
    const llmModel = await resolveLanguageModel("clarify", { modelId: model, apiKey });
    const facts = JSON.stringify(attributes, null, 2);
    const { object } = await generateObject({
      model: llmModel,
      schema: clarifyingOptionsRawSchema,
      system: CLARIFY_SYSTEM_PROMPT,
      prompt: `Item attributes (the seller's photographed used item):\n${facts}\n\nList the clarifying options.`,
    });
    return object as RawClarifyingOptions;
  };
}
