import {
  type ExtractedAttributes,
  type ListingCopy,
  listingCopySchema,
} from "../pipeline/types";
import { DEFAULT_LISTING_MODEL, enforceTitleLength } from "../listing";
import {
  FACEBOOK_DESCRIPTION_MAX_LENGTH,
  FACEBOOK_PLATFORM,
  FACEBOOK_TITLE_MAX_LENGTH,
  MERCARI_DESCRIPTION_MAX_LENGTH,
  MERCARI_MAX_HASHTAGS,
  MERCARI_PLATFORM,
  MERCARI_TITLE_MAX_LENGTH,
  facebookPackSchema,
  mercariPackSchema,
  rawExportPacksSchema,
  type FacebookPack,
  type MercariPack,
  type RawExportPacks,
} from "./schema";

/**
 * Facebook Marketplace + Mercari export packs (issue #15). One Zod-validated
 * attribute core → two platform-conventional, copy-paste-ready packs:
 *
 *  - FACEBOOK: casual tone, short blurb, LOCAL-PICKUP framing;
 *  - MERCARI: short keyword-first title (≤ 40 chars), shipping-oriented
 *    description, up to 3 hashtags;
 *
 * each rendered as one clean copy-paste BLOCK (a single string).
 *
 * Mirrors `listing/generate.ts` (the canonical #9 pattern):
 *  - the MODEL call is INJECTED (`generate`) and defaults to a lazy
 *    `generateObject` wrapper, so tests run fully offline (no network / key);
 *  - the returned packs ALWAYS satisfy the platform contracts: title/description
 *    caps are repaired deterministically, Mercari hashtags are normalized and
 *    WHITELISTED to tokens derivable from the validated core (so a hashtag can
 *    never assert a brand/model/spec the core never established), and the
 *    results are validated against the strict pack schemas;
 *  - the PRICE is never generated. If the caller passes the item's stored price
 *    it is appended deterministically to the Facebook block; the model is told
 *    not to state one. No price → no price line. (The price source of truth
 *    stays whatever the item record carries — this module just renders it.)
 */

/**
 * The injectable model call. Given the validated attribute core, it returns the
 * raw (pre-repair) packs for both platforms in one shot. The real wrapper drives
 * `generateObject` with `rawExportPacksSchema`; tests pass a fake. `attempt`
 * lets the real wrapper nudge the prompt on a constraint-repair retry.
 */
export type ExportPackGenerate = (args: {
  model: string;
  attributes: ExtractedAttributes;
  attempt: number;
}) => Promise<RawExportPacks>;

export interface GenerateExportPacksInput {
  /** The Zod-validated attribute core. The ONLY source of truth for facts. */
  attributes: ExtractedAttributes;
  /**
   * The item's STORED price (whatever the item record carries today — e.g. the
   * latest prediction log's recommendation). Rendered verbatim into the
   * Facebook block; never invented and never sent to the model.
   */
  price?: number;
  /** Injected model call. Defaults to the real lazy `generateObject` wrapper. */
  generate?: ExportPackGenerate;
  /** Constraint-repair retries before settling for the deterministic repair. Default 1. */
  maxRetries?: number;
  /** Model id override (else `EXPORT_PACK_MODEL` / `LISTING_MODEL` env, else default). */
  model?: string;
}

/** One platform's finished pack: validated fields + the paste-ready block. */
export interface ExportPackResult<P> {
  /** The validated, platform-shaped pack (passed its strict schema). */
  pack: P;
  /** The single clean copy-paste string the user pastes into the platform. */
  copyBlock: string;
  /** The same pack mapped onto the generic, persistable `ListingCopy` seam. */
  copy: ListingCopy;
}

export interface GenerateExportPacksResult {
  facebook: ExportPackResult<FacebookPack>;
  mercari: ExportPackResult<MercariPack>;
  /** The model id used (logged for evaluation). */
  model: string;
}

// ---------------------------------------------------------------------------
// No-hallucination guard for the STRUCTURED surface: Mercari hashtags. Each
// hashtag is normalized and then WHITELISTED against tokens derivable from the
// validated core (brand / model / category / condition / specs / extracted
// title words). Anything else the model emitted is an invented attribute claim
// and is dropped deterministically — the structural complement to the prompt's
// "use only the supplied facts" rule, exactly like the eBay specifics whitelist.
// ---------------------------------------------------------------------------

/** Collapse a string to its lowercase alphanumeric body ("Noise-Cancelling" → "noisecancelling"). */
function collapse(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Normalize a model-emitted hashtag to Mercari form: `#` + lowercase
 * alphanumerics. Returns null when nothing survives normalization.
 */
export function normalizeHashtag(raw: string): string | null {
  const body = collapse(raw.replace(/^#+/, ""));
  return body ? `#${body}` : null;
}

/**
 * Every hashtag body derivable from the validated core: each core string's
 * collapsed whole ("wh1000xm4") and its individual words ("noise", "cancelling"),
 * plus the collapsed brand+model compound ("sonywh1000xm4") — the common
 * hashtag forms. This is the COMPLETE allowed vocabulary; nothing else passes.
 */
export function derivableHashtagBodies(attrs: ExtractedAttributes): Set<string> {
  const bodies = new Set<string>();
  const sources = [
    attrs.brand,
    attrs.model,
    attrs.category,
    attrs.condition,
    attrs.title,
    ...(attrs.specs ?? []),
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  for (const source of sources) {
    const whole = collapse(source);
    if (whole) bodies.add(whole);
    for (const word of source.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word) bodies.add(word);
    }
  }
  if (attrs.brand && attrs.model) {
    const compound = collapse(attrs.brand + attrs.model);
    if (compound) bodies.add(compound);
  }
  return bodies;
}

/**
 * Deterministic fallback hashtags straight from the core (brand → model →
 * category), used when the model emitted none that survive the whitelist.
 * May be empty for a bare core — the schema allows 0 hashtags.
 */
export function deriveDefaultHashtags(attrs: ExtractedAttributes): string[] {
  const out: string[] = [];
  for (const source of [attrs.brand, attrs.model, attrs.category]) {
    if (!source) continue;
    const tag = normalizeHashtag(source);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length === MERCARI_MAX_HASHTAGS) break;
  }
  return out;
}

/**
 * Reconcile the model's hashtags to ONLY core-derivable, normalized, deduped
 * tags, capped at the Mercari bound. Falls back to `deriveDefaultHashtags`
 * when nothing survives, so a well-formed core still yields useful tags.
 */
export function reconcileHashtags(
  raw: string[],
  attrs: ExtractedAttributes,
): string[] {
  const allowed = derivableHashtagBodies(attrs);
  const out: string[] = [];
  for (const candidate of raw) {
    const tag = normalizeHashtag(candidate);
    if (!tag || !allowed.has(tag.slice(1))) continue;
    if (!out.includes(tag)) out.push(tag);
    if (out.length === MERCARI_MAX_HASHTAGS) break;
  }
  return out.length > 0 ? out : deriveDefaultHashtags(attrs);
}

/**
 * Did the RAW model output invent hashtag attributes beyond the validated core?
 * Used (like `listingHallucinatesAttributes`) to prefer a self-correcting retry;
 * the deterministic whitelist guarantees a clean result regardless.
 */
export function packsHallucinateAttributes(
  raw: RawExportPacks,
  attrs: ExtractedAttributes,
): boolean {
  const allowed = derivableHashtagBodies(attrs);
  return raw.mercari.hashtags.some((candidate) => {
    const tag = normalizeHashtag(candidate);
    return tag != null && !allowed.has(tag.slice(1));
  });
}

// ---------------------------------------------------------------------------
// Deterministic repairs + the copy-paste blocks
// ---------------------------------------------------------------------------

/** The deterministic shipping line appended when the model forgot to mention shipping. */
export const MERCARI_SHIPPING_SUFFIX = "Ships fast with tracking.";

/** The deterministic Facebook local-pickup line — always the block's last line. */
export const FACEBOOK_PICKUP_LINE = "Local pickup — message me if interested!";

/**
 * Repair the Mercari description so the returned pack is ALWAYS ≤ the cap AND
 * shipping-oriented: if the (possibly truncated) text never mentions shipping,
 * the neutral platform-true suffix is appended — a Mercari-mechanics statement,
 * not an item attribute, so it cannot hallucinate facts about the item.
 */
export function repairMercariDescription(raw: string): string {
  const trimmed = raw.trim();
  if (/ship/i.test(trimmed) && trimmed.length <= MERCARI_DESCRIPTION_MAX_LENGTH) {
    return trimmed;
  }
  const budget = MERCARI_DESCRIPTION_MAX_LENGTH - MERCARI_SHIPPING_SUFFIX.length - 1;
  const cut = enforceTitleLength(trimmed, budget);
  if (/ship/i.test(cut)) return cut;
  return cut.length > 0 ? `${cut} ${MERCARI_SHIPPING_SUFFIX}` : MERCARI_SHIPPING_SUFFIX;
}

/** Render a stored price for the block ("$45" / "$49.99"). */
export function formatPrice(price: number): string {
  return Number.isInteger(price) ? `$${price}` : `$${price.toFixed(2)}`;
}

/**
 * The Facebook Marketplace copy-paste block: title, blank line, the short
 * casual description, then deterministic meta lines — the core's condition
 * (only if the core established one), the STORED price (only if the caller
 * passed one), and the constant local-pickup line. Every fact line is
 * assembled here from validated inputs, never model free text.
 */
export function facebookCopyBlock(
  pack: FacebookPack,
  opts: { price?: number; condition?: string } = {},
): string {
  const meta: string[] = [];
  if (opts.condition) meta.push(`Condition: ${opts.condition}`);
  if (opts.price != null) meta.push(`Asking ${formatPrice(opts.price)}`);
  meta.push(FACEBOOK_PICKUP_LINE);
  return [pack.title, "", pack.description, "", ...meta].join("\n");
}

/**
 * The Mercari copy-paste block: short title, blank line, shipping-oriented
 * description, then the (core-whitelisted) hashtag line when any survived.
 */
export function mercariCopyBlock(pack: MercariPack): string {
  const parts = [pack.title, "", pack.description];
  if (pack.hashtags.length > 0) parts.push("", pack.hashtags.join(" "));
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// ListingCopy mapping (the persistable seam, same as the eBay slice)
// ---------------------------------------------------------------------------

/** Map a validated Facebook pack onto the generic `ListingCopy` seam. */
export function facebookPackToListingCopy(
  pack: FacebookPack,
  copyBlock: string,
): ListingCopy {
  return listingCopySchema.parse({
    platform: FACEBOOK_PLATFORM,
    title: pack.title,
    description: pack.description,
    fields: { copyBlock },
  });
}

/** Map a validated Mercari pack onto the generic `ListingCopy` seam. */
export function mercariPackToListingCopy(
  pack: MercariPack,
  copyBlock: string,
): ListingCopy {
  return listingCopySchema.parse({
    platform: MERCARI_PLATFORM,
    title: pack.title,
    description: pack.description,
    fields: { hashtags: pack.hashtags, copyBlock },
  });
}

// ---------------------------------------------------------------------------
// The generation entrypoint
// ---------------------------------------------------------------------------

function resolveModel(model?: string): string {
  return (
    model?.trim() ||
    process.env.EXPORT_PACK_MODEL?.trim() ||
    process.env.LISTING_MODEL?.trim() ||
    DEFAULT_LISTING_MODEL
  );
}

interface ReconciledPacks {
  facebook: FacebookPack;
  mercari: MercariPack;
}

/** Deterministic constraint repair: after this, both packs provably satisfy their schemas. */
function reconcilePacks(
  raw: RawExportPacks,
  attributes: ExtractedAttributes,
): ReconciledPacks {
  return {
    facebook: {
      title: enforceTitleLength(raw.facebook.title, FACEBOOK_TITLE_MAX_LENGTH),
      description: enforceTitleLength(
        raw.facebook.description,
        FACEBOOK_DESCRIPTION_MAX_LENGTH,
      ),
    },
    mercari: {
      title: enforceTitleLength(raw.mercari.title, MERCARI_TITLE_MAX_LENGTH),
      description: repairMercariDescription(raw.mercari.description),
      hashtags: reconcileHashtags(raw.mercari.hashtags, attributes),
    },
  };
}

function assembleResult(
  packs: ReconciledPacks,
  input: GenerateExportPacksInput,
  model: string,
): GenerateExportPacksResult {
  const fbBlock = facebookCopyBlock(packs.facebook, {
    price: input.price,
    condition: input.attributes.condition,
  });
  const mercariBlock = mercariCopyBlock(packs.mercari);
  return {
    facebook: {
      pack: packs.facebook,
      copyBlock: fbBlock,
      copy: facebookPackToListingCopy(packs.facebook, fbBlock),
    },
    mercari: {
      pack: packs.mercari,
      copyBlock: mercariBlock,
      copy: mercariPackToListingCopy(packs.mercari, mercariBlock),
    },
    model,
  };
}

/**
 * Generate both export packs from the attribute core.
 *
 * Flow per attempt (mirrors `generateEbayListing`): call the injected
 * `generate`, deterministically repair lengths / shipping orientation /
 * hashtags, validate against the strict pack schemas. If the RAW output
 * hallucinated hashtag attributes, retry so the model can self-correct; the
 * reconciled candidate is kept as the guaranteed-clean fallback.
 */
export async function generateExportPacks(
  input: GenerateExportPacksInput,
): Promise<GenerateExportPacksResult> {
  const { attributes, maxRetries = 1 } = input;
  const model = resolveModel(input.model);
  const generate = input.generate ?? createOpenAIExportPackGenerate();

  const attempts = maxRetries + 1;
  let lastError = "";
  let lastReconciled: ReconciledPacks | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let raw: RawExportPacks;
    try {
      raw = await generate({ model, attributes, attempt });
    } catch (err) {
      // The real `generateObject` THROWS on a schema-invalid response. Treat a
      // throw as a failed attempt and retry (mirrors listing/generate).
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }

    const reconciled = reconcilePacks(raw, attributes);

    const fbParsed = facebookPackSchema.safeParse(reconciled.facebook);
    const mercariParsed = mercariPackSchema.safeParse(reconciled.mercari);
    if (!fbParsed.success || !mercariParsed.success) {
      lastError = [
        ...(fbParsed.success ? [] : fbParsed.error.issues),
        ...(mercariParsed.success ? [] : mercariParsed.error.issues),
      ]
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      continue;
    }
    lastReconciled = { facebook: fbParsed.data, mercari: mercariParsed.data };

    // If the RAW output invented hashtag attributes, prefer a retry so the model
    // can self-correct; the reconciled candidate is already clean and is kept as
    // the fallback for the final attempt.
    if (packsHallucinateAttributes(raw, attributes) && attempt < attempts - 1) {
      lastError =
        "generated packs introduced hashtag attributes beyond the validated core";
      continue;
    }

    return assembleResult(lastReconciled, input, model);
  }

  // Attempts exhausted. A reconciled candidate (kept while retrying on
  // hallucination) provably satisfies the contract — return it. Otherwise the
  // model never produced anything usable.
  if (lastReconciled) return assembleResult(lastReconciled, input, model);

  throw new Error(
    `Export pack generation failed after ${attempts} attempt(s). Last error: ${lastError}`,
  );
}

// ---------------------------------------------------------------------------
// Real OpenAI generate — lazy, env-gated. Used only when nothing is injected.
// Never imported by the offline tests.
// ---------------------------------------------------------------------------

/**
 * System guidance: platform-conventional copy GROUNDED strictly in the supplied
 * facts. The hard no-hallucination instruction is the prompt-side complement to
 * the code-side repairs (length caps, shipping suffix, hashtag whitelist).
 */
const EXPORT_PACK_SYSTEM_PROMPT =
  "You write copy-paste resale listings for Facebook Marketplace and Mercari. " +
  "Use ONLY the supplied attribute facts (brand, model, category, condition, specs) — " +
  "never invent a brand, model, spec, measurement, flaw, or accessory that is not given. " +
  "Never state a price; pricing is handled separately. " +
  `FACEBOOK MARKETPLACE: casual, friendly, short (2–4 sentences), written for a local ` +
  `pickup sale; title ≤ ${FACEBOOK_TITLE_MAX_LENGTH} characters; no hashtags, no emoji spam. ` +
  `MERCARI: keyword-first title of ${MERCARI_TITLE_MAX_LENGTH} characters or fewer; a short ` +
  "shipping-oriented description (mention that it ships); plus up to " +
  `${MERCARI_MAX_HASHTAGS} lowercase hashtags built ONLY from the given brand/model/category/spec words.`;

/**
 * Build the real generate: a lazy wrapper around the AI SDK's `generateObject`
 * with the permissive `rawExportPacksSchema` (so repairable violations reach the
 * deterministic repair instead of throwing in the SDK). Imported lazily, like
 * `listing/generate.ts`, so the SDK never loads on the offline test path.
 */
export function createOpenAIExportPackGenerate(
  apiKey: string | undefined = process.env.OPENAI_API_KEY,
): ExportPackGenerate {
  return async ({ model, attributes, attempt }) => {
    const [{ generateObject }, { createOpenAI }] = await Promise.all([
      import("ai"),
      import("@ai-sdk/openai"),
    ]);
    const openai = createOpenAI(apiKey ? { apiKey } : {});

    const facts = JSON.stringify(attributes, null, 2);
    const instruction =
      attempt === 0
        ? `Write the Facebook Marketplace pack and the Mercari pack for this item.\n\nValidated attributes (the ONLY allowed facts):\n${facts}`
        : `Your previous response violated the platform constraints (Facebook title ≤ ${FACEBOOK_TITLE_MAX_LENGTH}, Mercari title ≤ ${MERCARI_TITLE_MAX_LENGTH}, ≤ ${MERCARI_MAX_HASHTAGS} hashtags drawn only from the given facts, no attributes beyond the validated core). Regenerate strictly using only these facts:\n${facts}`;

    const { object } = await generateObject({
      model: openai.chat(model),
      schema: rawExportPacksSchema,
      system: EXPORT_PACK_SYSTEM_PROMPT,
      prompt: instruction,
    });
    return object as RawExportPacks;
  };
}
