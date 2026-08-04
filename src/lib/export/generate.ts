import {
  type ExtractedAttributes,
  type ListingCopy,
  listingCopySchema,
} from "../pipeline/types";
import { enforceTitleLength } from "../listing";
import { resolveLanguageModel, resolveModelId } from "../llm";
import { safeSellerCoreValue, sellerCopyViolations } from "../seller-copy";
import {
  DEPOP_DESCRIPTION_MAX_LENGTH,
  DEPOP_MAX_HASHTAGS,
  DEPOP_PLATFORM,
  FACEBOOK_DESCRIPTION_MAX_LENGTH,
  FACEBOOK_PLATFORM,
  FACEBOOK_TITLE_MAX_LENGTH,
  MERCARI_DESCRIPTION_MAX_LENGTH,
  MERCARI_MAX_HASHTAGS,
  MERCARI_PLATFORM,
  MERCARI_TITLE_MAX_LENGTH,
  depopPackSchema,
  facebookPackSchema,
  mercariPackSchema,
  rawExportPacksSchema,
  type DepopPack,
  type FacebookPack,
  type MercariPack,
  type RawExportPacks,
} from "./schema";

/**
 * Facebook Marketplace + Mercari export packs (issue #15). One Zod-validated
 * attribute core → two platform-conventional, copy-paste-ready packs:
 *
 *  - FACEBOOK: concise title and factual description;
 *  - MERCARI: short keyword-first title (≤ 40 chars), factual description,
 *    and up to 3 hashtags;
 *
 * each rendered as one clean copy-paste BLOCK (a single string).
 *
 * Mirrors `listing/generate.ts` (the canonical #9 pattern):
 *  - the MODEL call is INJECTED (`generate`) and defaults to a lazy
 *    `generateObject` wrapper, so tests run fully offline (no network / key);
 *  - the returned packs ALWAYS satisfy the platform contracts: title caps are
 *    repaired deterministically, Mercari hashtags are normalized and
 *    WHITELISTED to tokens derivable from the validated core (so a hashtag can
 *    never assert a brand/model/spec the core never established), and the
 *    results are validated against the strict pack schemas;
 *  - the PRICE is never generated. If the caller passes the item's effective
 *    price it is carried separately on BOTH platform packs (for each
 *    marketplace's price field) and appended deterministically only to the
 *    Facebook block; the model is told not to state one. No price → no price
 *    line. (The price source of truth stays upstream — this module renders it.)
 *
 * THE NO-HALLUCINATION GUARANTEE, channel by channel (PRD: "no attributes
 * hallucinated beyond the validated core"):
 *  - TITLES are model-generated (short, attribute-bearing strings where
 *    token-boundary numeric grounding works), validated against the core, and
 *    replaced with deterministic core-built fallbacks when ungrounded;
 *  - DESCRIPTIONS are ALWAYS assembled deterministically from the validated
 *    core (`buildFacebookDescription` / `buildMercariDescription`). The model
 *    never authors published description text: an invented DIGIT-FREE claim
 *    ("Includes charger", "Waterproof") cannot be detected deterministically in
 *    free text, so the only sound defense is to not publish free text at all.
 *    Any description the model happens to emit is ignored;
 *  - HASHTAGS are whitelisted against tokens derivable from the core.
 * So no free-text channel exists through which an invented attribute can reach
 * the published packs.
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
   * The item's effective price (seller override, otherwise latest suggestion).
   * Carried on every platform result and rendered verbatim into the Facebook
   * block; never invented and never sent to the model.
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
  /** Effective price to enter in the platform's separate price field. */
  price: number | null;
  /** The single clean copy-paste string the user pastes into the platform. */
  copyBlock: string;
  /** The same pack mapped onto the generic, persistable `ListingCopy` seam. */
  copy: ListingCopy;
}

export interface GenerateExportPacksResult {
  facebook: ExportPackResult<FacebookPack>;
  mercari: ExportPackResult<MercariPack>;
  /**
   * The Depop pack (issue #378). Assembled entirely from the validated core —
   * the model is never asked for Depop copy, so this destination adds no new
   * free-text channel through which an invented attribute could reach a pack.
   */
  depop: ExportPackResult<DepopPack>;
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

// ---------------------------------------------------------------------------
// No-hallucination guard for the model's remaining free-text surface: the two
// TITLES. (Descriptions are assembled deterministically from the core and
// never carry model text — see the builders below.) The model can smuggle an
// unsupported fact or price into a title just as easily as into a hashtag, so
// the same allowlist stance applies — and numbers are grounded ON TOKEN
// BOUNDARIES, never by substring membership:
//
//  (a) a number embedded in an alphanumeric token ("WH-1000XM4", "128GB",
//      "50-hour") is grounded only when that token EQUALS, case-insensitively,
//      a token of a validated core value (both sides run through the same
//      tokenizer) — core "128GB" does NOT license "8GB", and core "150-hour"
//      does NOT license "50-hour";
//  (b) a STANDALONE number is grounded only when the same number appears as a
//      standalone token in a core value — digits mined out of identifiers
//      ("4" from "WH-1000XM4") never count;
//  (c) the effective price NEVER grounds free text: prices are appended
//      deterministically by `facebookCopyBlock`, and currency-like spans
//      ("$50", "50 dollars") are ALWAYS violations.
// ---------------------------------------------------------------------------

/**
 * Tokenize text into comparable units: lowercase alphanumeric runs joined by
 * INTERNAL hyphens/dots ("WH-1000XM4" → "wh-1000xm4", "1.5m" → "1.5m",
 * "cables." → "cables"). The same tokenizer is applied to core values and to
 * model free text, so grounding compares like with like.
 */
const TOKEN_PATTERN = /[a-z0-9]+(?:[.\-][a-z0-9]+)*/g;

function tokenize(s: string): string[] {
  return s.toLowerCase().match(TOKEN_PATTERN) ?? [];
}

/** Is this token a bare number ("4", "50", "49.99") rather than an identifier? */
function isStandaloneNumber(token: string): boolean {
  return /^\d+(?:\.\d+)?$/.test(token);
}

/** The contextual grounding evidence derived from the validated core. */
export interface NumericGrounding {
  /**
   * Every token of every core value (same tokenizer as generated text) — an
   * alphanumeric generated token is grounded only by EQUALITY with one of
   * these, never by substring containment (core "128GB" must not license a
   * generated "8GB").
   */
  coreTokens: Set<string>;
  /** Numbers that appear as STANDALONE tokens in a core value. */
  standaloneNumbers: Set<string>;
}

/**
 * Build the contextual grounding from the validated core fields (brand, model,
 * category, condition, isbn, upc, specs, title). Deliberately EXCLUDES the
 * effective price: the model is never allowed to write a price, so the price can
 * never ground a number in free text.
 */
export function buildNumericGrounding(
  attrs: ExtractedAttributes,
): NumericGrounding {
  const coreValues = [
    attrs.brand,
    attrs.model,
    attrs.category,
    attrs.condition,
    attrs.isbn,
    attrs.upc,
    attrs.title,
    ...(attrs.specs ?? []),
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  const coreTokens = new Set<string>();
  const standaloneNumbers = new Set<string>();
  for (const value of coreValues) {
    for (const token of tokenize(value)) {
      coreTokens.add(token);
      if (isStandaloneNumber(token)) standaloneNumbers.add(token);
    }
  }
  return { coreTokens, standaloneNumbers };
}

/** Currency-like spans the model must NEVER write: "$50", "50 dollars", "50 usd"… */
const CURRENCY_PATTERN =
  /\$\s*\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:dollars?|bucks?|usd)\b/gi;

/**
 * Every grounding violation in one free-text string: currency-like spans
 * (always violations — prices are appended deterministically, never written by
 * the model) plus any numeric token whose CONTEXT is not grounded — an
 * alphanumeric token (digits + letters/joiners) must EQUAL a token of a core
 * value (token-boundary comparison, both sides tokenized identically), and a
 * standalone number must match a standalone number in a core value. Empty
 * array ⇔ the text makes no ungrounded numeric/price claim.
 */
export function findUngroundedNumbers(
  text: string,
  grounding: NumericGrounding,
): string[] {
  const violations: string[] = [];
  violations.push(...(text.match(CURRENCY_PATTERN) ?? []));
  for (const token of tokenize(text)) {
    if (!/\d/.test(token)) continue;
    if (isStandaloneNumber(token)) {
      if (!grounding.standaloneNumbers.has(token)) violations.push(token);
    } else if (!grounding.coreTokens.has(token)) {
      violations.push(token);
    }
  }
  return violations;
}

/**
 * Does either generated TITLE make a numeric/price claim the validated core
 * never established? Titles publish to the platforms verbatim (after length
 * repair), so a mutated identifier like "WH-1000XM5" must be caught here, not
 * only in descriptions.
 */
/**
 * Digit-free connectives a title may use freely: pure function words and
 * marketplace filler that cannot assert a product fact. Everything else in a
 * generated title must be a token of the validated core (which includes the
 * vision-validated display title, so grounded phrasing keeps its latitude).
 */
const TITLE_CONNECTIVES = new Set([
  "a", "an", "the", "and", "or", "for", "with", "of", "in", "on", "by", "to",
]);

/**
 * Every grounding violation in one generated TITLE: ungrounded numeric/price
 * claims (same rules as free text) PLUS any digit-free token that is neither
 * a core token nor a connective — "Includes Charger" or "Waterproof" is a
 * violation even though it carries no digits. Titles are the one remaining
 * model-authored published surface, so they get the strictest guard.
 */
export function titleViolations(
  title: string,
  grounding: NumericGrounding,
): string[] {
  const violations = [...findUngroundedNumbers(title, grounding)];
  for (const token of tokenize(title)) {
    if (/\d/.test(token)) continue; // numeric/alphanumeric handled above
    if (grounding.coreTokens.has(token)) continue;
    if (TITLE_CONNECTIVES.has(token)) continue;
    violations.push(token);
  }
  return violations;
}

export function titlesViolateGrounding(
  raw: RawExportPacks,
  attrs: ExtractedAttributes,
): boolean {
  const grounding = buildNumericGrounding(attrs);
  return (
    sellerCopyViolations(raw.facebook.title).length > 0 ||
    sellerCopyViolations(raw.mercari.title).length > 0 ||
    titleViolations(raw.facebook.title, grounding).length > 0 ||
    titleViolations(raw.mercari.title, grounding).length > 0
  );
}

/**
 * Did the RAW model output invent attributes beyond the validated core on a
 * PUBLISHED surface — an underivable Mercari hashtag OR an ungrounded
 * number/price in either title? Used (like `listingHallucinatesAttributes`) to
 * prefer a self-correcting retry; the deterministic whitelist + title
 * fallbacks guarantee a clean result regardless. Model-emitted DESCRIPTIONS
 * are deliberately NOT inspected: they are never published (descriptions are
 * assembled deterministically from the core), so a dirty one costs nothing and
 * never warrants a retry.
 */
export function packsHallucinateAttributes(
  raw: RawExportPacks,
  attrs: ExtractedAttributes,
): boolean {
  const allowed = derivableHashtagBodies(attrs);
  const badHashtag = raw.mercari.hashtags.some((candidate) => {
    const tag = normalizeHashtag(candidate);
    return tag != null && !allowed.has(tag.slice(1));
  });
  return badHashtag || titlesViolateGrounding(raw, attrs);
}

// ---------------------------------------------------------------------------
// Deterministic repairs + the copy-paste blocks
// ---------------------------------------------------------------------------

/**
 * The deterministic shipping line appended when the model forgot to mention
 * shipping. NEUTRAL by design: it states only that the item ships (a Mercari
 * platform mechanic), never speed or tracking — seller-performance promises
 * aren't in the validated core or any shipping settings, so asserting them
 * would be exactly the hallucination this feature guards against.
 */
/**
 * Deterministic description built ONLY from the validated core — the ONLY
 * source of published description text. Every word traces to a core field, so
 * it is grounded by construction (any digits it contains came from the core
 * itself), and an invented digit-free claim ("Includes charger", "Waterproof")
 * structurally cannot appear: there is no model text here to carry one.
 */
export function buildCoreDescription(attrs: ExtractedAttributes): string {
  const name =
    [safeSellerCoreValue(attrs.brand), safeSellerCoreValue(attrs.model)]
      .filter(Boolean)
      .join(" ") ||
    safeSellerCoreValue(attrs.title) ||
    safeSellerCoreValue(attrs.category) ||
    "this item";
  const sentences = [`For sale: ${name}.`];
  const condition = safeSellerCoreValue(attrs.condition);
  if (condition) sentences.push(`Condition: ${condition}.`);
  const specs = (attrs.specs ?? [])
    .map((spec) => safeSellerCoreValue(spec))
    .filter((spec): spec is string => Boolean(spec));
  if (specs.length > 0) {
    sentences.push(`Details: ${specs.join(", ")}.`);
  }
  return sentences.join(" ");
}

/**
 * The PUBLISHED Facebook description: the core-only description capped at the
 * FB structural limit (word-boundary truncation, same repair as titles).
 */
export function buildFacebookDescription(attrs: ExtractedAttributes): string {
  return enforceTitleLength(buildCoreDescription(attrs), FACEBOOK_DESCRIPTION_MAX_LENGTH);
}

/**
 * The PUBLISHED Mercari description: core-only text capped at the platform limit.
 * Shipping is a seller policy, not an item fact, so this pack never claims it.
 */
export function buildMercariDescription(attrs: ExtractedAttributes): string {
  return enforceTitleLength(buildCoreDescription(attrs), MERCARI_DESCRIPTION_MAX_LENGTH);
}

/**
 * The PUBLISHED Depop description (issue #378). Depop has no title field and
 * its search weights the OPENING words of the description most heavily, so the
 * item's identity leads instead of a "For sale:" preamble. Built only from the
 * validated core and capped at Depop's limit by word-boundary truncation.
 */
export function buildDepopDescription(attrs: ExtractedAttributes): string {
  const name =
    [safeSellerCoreValue(attrs.brand), safeSellerCoreValue(attrs.model)]
      .filter(Boolean)
      .join(" ") ||
    safeSellerCoreValue(attrs.title) ||
    safeSellerCoreValue(attrs.category) ||
    "Item for sale";
  const sentences = [`${name}.`];
  const condition = safeSellerCoreValue(attrs.condition);
  if (condition) sentences.push(`Condition: ${condition}.`);
  const specs = (attrs.specs ?? [])
    .map((spec) => safeSellerCoreValue(spec))
    .filter((spec): spec is string => Boolean(spec));
  if (specs.length > 0) {
    sentences.push(`Details: ${specs.join(", ")}.`);
  }
  return enforceTitleLength(sentences.join(" "), DEPOP_DESCRIPTION_MAX_LENGTH);
}

/**
 * Depop hashtags: the same core-derived vocabulary Mercari uses, in the core's
 * own priority order (brand → model → category → specs), normalized, deduped,
 * and bounded at Depop's cap. No model text participates, so a Depop hashtag
 * can never assert an attribute the core never established.
 */
export function deriveDepopHashtags(attrs: ExtractedAttributes): string[] {
  const out: string[] = [];
  const sources = [
    attrs.brand,
    attrs.model,
    attrs.category,
    ...(attrs.specs ?? []),
  ];
  for (const source of sources) {
    if (!source) continue;
    const tag = normalizeHashtag(source);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length === DEPOP_MAX_HASHTAGS) break;
  }
  return out;
}

/**
 * Deterministic title built ONLY from the validated core — the fallback
 * published when a generated title makes an ungrounded numeric claim (e.g. a
 * mutated model number) on its final attempt. Grounded by construction.
 */
export function fallbackTitle(attrs: ExtractedAttributes): string {
  return (
    [safeSellerCoreValue(attrs.brand), safeSellerCoreValue(attrs.model)]
      .filter(Boolean)
      .join(" ") ||
    safeSellerCoreValue(attrs.title) ||
    safeSellerCoreValue(attrs.category) ||
    "Item for sale"
  );
}

/** The Facebook-shaped deterministic fallback title (≤ the FB cap). */
export function fallbackFacebookTitle(attrs: ExtractedAttributes): string {
  return enforceTitleLength(fallbackTitle(attrs), FACEBOOK_TITLE_MAX_LENGTH);
}

/** The Mercari-shaped deterministic fallback title (≤ the Mercari cap). */
export function fallbackMercariTitle(attrs: ExtractedAttributes): string {
  return enforceTitleLength(fallbackTitle(attrs), MERCARI_TITLE_MAX_LENGTH);
}

/** Render the caller-resolved effective price for the block ("$45" / "$49.99"). */
export function formatPrice(price: number): string {
  return Number.isInteger(price) ? `$${price}` : `$${price.toFixed(2)}`;
}

/**
 * The Facebook Marketplace copy-paste block: title, blank line, factual
 * description, then the validated condition and caller-resolved price when present.
 */
export function facebookCopyBlock(
  pack: FacebookPack,
  opts: { price?: number; condition?: string } = {},
): string {
  const meta: string[] = [];
  const condition = safeSellerCoreValue(opts.condition);
  if (condition) meta.push(`Condition: ${condition}`);
  if (opts.price != null) meta.push(`Asking ${formatPrice(opts.price)}`);
  return [pack.title, "", pack.description, "", ...meta].join("\n");
}

/**
 * The Mercari copy-paste block: short title, blank line, factual description,
 * then the core-whitelisted hashtag line when any survived.
 */
export function mercariCopyBlock(pack: MercariPack): string {
  const parts = [pack.title, "", pack.description];
  if (pack.hashtags.length > 0) parts.push("", pack.hashtags.join(" "));
  return parts.join("\n");
}

/**
 * The Depop copy-paste block: the keyword-first description, then the
 * core-derived hashtag line when any exist. No title line — Depop has no title
 * field, and rendering one would describe a field the seller cannot fill.
 */
export function depopCopyBlock(pack: DepopPack): string {
  const parts = [pack.description];
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
  price: number | null = null,
): ListingCopy {
  return listingCopySchema.parse({
    platform: FACEBOOK_PLATFORM,
    title: pack.title,
    description: pack.description,
    fields: { copyBlock, price },
  });
}

/** Map a validated Mercari pack onto the generic `ListingCopy` seam. */
export function mercariPackToListingCopy(
  pack: MercariPack,
  copyBlock: string,
  price: number | null = null,
): ListingCopy {
  return listingCopySchema.parse({
    platform: MERCARI_PLATFORM,
    title: pack.title,
    description: pack.description,
    fields: { hashtags: pack.hashtags, copyBlock, price },
  });
}

/**
 * Map a validated Depop pack onto the generic `ListingCopy` seam. `title` is
 * ROW IDENTITY only — the deterministic core name, so the persisted row is
 * identifiable in storage. It is never rendered into the Depop copy block,
 * because Depop's listing form has no title field to paste it into.
 */
export function depopPackToListingCopy(
  pack: DepopPack,
  copyBlock: string,
  rowTitle: string,
  price: number | null = null,
): ListingCopy {
  return listingCopySchema.parse({
    platform: DEPOP_PLATFORM,
    title: rowTitle,
    description: pack.description,
    fields: { hashtags: pack.hashtags, copyBlock, price },
  });
}

// ---------------------------------------------------------------------------
// The generation entrypoint
// ---------------------------------------------------------------------------

function resolveModel(model?: string): string {
  // Preserve the EXPORT_PACK_MODEL -> LISTING_MODEL fallback BEFORE the provider
  // default: fold both env vars into the explicit `modelId` so the registry's
  // role-default only fires when neither override is set.
  const override =
    model?.trim() || process.env.EXPORT_PACK_MODEL?.trim() || process.env.LISTING_MODEL?.trim();
  return resolveModelId("export", { modelId: override });
}

interface ReconciledPacks {
  facebook: FacebookPack;
  mercari: MercariPack;
  depop: DepopPack;
}

/**
 * Deterministic constraint repair: after this, both packs provably satisfy
 * their schemas AND carry no attribute the core never established. Title
 * length caps are repaired by truncation; a title carrying a number/price the
 * core never established is REPLACED with the deterministic core-only fallback
 * (truncation alone would publish the claim); hashtags are whitelisted; and
 * DESCRIPTIONS are assembled from the core unconditionally — any description
 * the model emitted is discarded, because an invented digit-free claim in free
 * text cannot be detected deterministically.
 */
function reconcilePacks(
  raw: RawExportPacks,
  attributes: ExtractedAttributes,
): ReconciledPacks {
  const grounding = buildNumericGrounding(attributes);
  // Titles use the FULL guard (numeric + digit-free token allowlist) — the
  // deterministic fallback must kick in for "Includes Charger" exactly as it
  // does for an ungrounded number.
  const grounded = (text: string) => titleViolations(text, grounding).length === 0;
  return {
    facebook: {
      title: grounded(raw.facebook.title)
        ? enforceTitleLength(raw.facebook.title, FACEBOOK_TITLE_MAX_LENGTH)
        : fallbackFacebookTitle(attributes),
      description: buildFacebookDescription(attributes),
    },
    mercari: {
      title: grounded(raw.mercari.title)
        ? enforceTitleLength(raw.mercari.title, MERCARI_TITLE_MAX_LENGTH)
        : fallbackMercariTitle(attributes),
      description: buildMercariDescription(attributes),
      hashtags: reconcileHashtags(raw.mercari.hashtags, attributes),
    },
    // Depop never consults `raw`: both fields come straight from the core.
    depop: {
      description: buildDepopDescription(attributes),
      hashtags: deriveDepopHashtags(attributes),
    },
  };
}

function assembleResult(
  packs: ReconciledPacks,
  input: GenerateExportPacksInput,
  model: string,
): GenerateExportPacksResult {
  const price = input.price ?? null;
  const fbBlock = facebookCopyBlock(packs.facebook, {
    price: input.price,
    condition: input.attributes.condition,
  });
  const mercariBlock = mercariCopyBlock(packs.mercari);
  const depopBlock = depopCopyBlock(packs.depop);
  const depopRowTitle = fallbackTitle(input.attributes);
  return {
    facebook: {
      pack: packs.facebook,
      price,
      copyBlock: fbBlock,
      copy: facebookPackToListingCopy(packs.facebook, fbBlock, price),
    },
    mercari: {
      pack: packs.mercari,
      price,
      copyBlock: mercariBlock,
      copy: mercariPackToListingCopy(packs.mercari, mercariBlock, price),
    },
    depop: {
      pack: packs.depop,
      price,
      copyBlock: depopBlock,
      copy: depopPackToListingCopy(packs.depop, depopBlock, depopRowTitle, price),
    },
    model,
  };
}

/**
 * Generate both export packs from the attribute core.
 *
 * Flow per attempt (mirrors `generateEbayListing`): call the injected
 * `generate` (which authors TITLES and HASHTAGS — published descriptions are
 * always assembled deterministically from the core), repair title lengths,
 * replace ungrounded titles with the core-only fallbacks, whitelist hashtags,
 * and validate against the strict pack schemas. If the RAW output hallucinated
 * on a published surface (an underivable hashtag OR an ungrounded title
 * number/price), retry so the model can self-correct; the reconciled candidate
 * is kept as the guaranteed-clean fallback.
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
    const depopParsed = depopPackSchema.safeParse(reconciled.depop);
    if (!fbParsed.success || !mercariParsed.success || !depopParsed.success) {
      lastError = [
        ...(fbParsed.success ? [] : fbParsed.error.issues),
        ...(mercariParsed.success ? [] : mercariParsed.error.issues),
        ...(depopParsed.success ? [] : depopParsed.error.issues),
      ]
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      continue;
    }
    lastReconciled = {
      facebook: fbParsed.data,
      mercari: mercariParsed.data,
      depop: depopParsed.data,
    };

    // If the RAW output invented attributes on a PUBLISHED surface (an
    // underivable hashtag OR an ungrounded number/price in either title),
    // prefer a retry so the model can self-correct; the reconciled candidate
    // is already clean and is kept as the fallback for the final attempt.
    if (packsHallucinateAttributes(raw, attributes) && attempt < attempts - 1) {
      lastError =
        "generated packs introduced attributes beyond the validated core (hashtag or title number/price)";
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
 * System guidance: platform-conventional TITLES and HASHTAGS grounded strictly
 * in the supplied facts. Descriptions are NOT requested — the published
 * descriptions are assembled deterministically from the validated core, so the
 * model has no free-text description channel to hallucinate into. The hard
 * no-hallucination instruction is the prompt-side complement to the code-side
 * guards (title grounding + length caps, hashtag whitelist).
 */
const EXPORT_PACK_SYSTEM_PROMPT =
  "You write the TITLES and Mercari HASHTAGS for copy-paste resale listings on " +
  "Facebook Marketplace and Mercari. Descriptions are assembled separately from " +
  "the validated facts — do not write descriptions. " +
  "Use ONLY the supplied attribute facts (brand, model, category, condition, specs) — " +
  "never invent a brand, model, spec, measurement, flaw, or accessory that is not given. " +
  "Never state a price; pricing is handled separately. " +
  `FACEBOOK MARKETPLACE: casual, friendly title ≤ ${FACEBOOK_TITLE_MAX_LENGTH} characters; ` +
  "no hashtags, no emoji spam. " +
  `MERCARI: keyword-first title of ${MERCARI_TITLE_MAX_LENGTH} characters or fewer, plus up to ` +
  `${MERCARI_MAX_HASHTAGS} lowercase hashtags built ONLY from the given brand/model/category/spec words.`;

/**
 * Build the real generate: a lazy wrapper around the AI SDK's `generateObject`
 * with the permissive `rawExportPacksSchema` (so repairable violations reach the
 * deterministic repair instead of throwing in the SDK). Imported lazily, like
 * `listing/generate.ts`, so the SDK never loads on the offline test path.
 */
export function createOpenAIExportPackGenerate(
  apiKey: string | undefined = undefined,
): ExportPackGenerate {
  return async ({ model, attributes, attempt }) => {
    const { generateObject } = await import("ai");
    const llmModel = await resolveLanguageModel("export", { modelId: model, apiKey });

    const facts = JSON.stringify(attributes, null, 2);
    const instruction =
      attempt === 0
        ? `Write the Facebook Marketplace title and the Mercari title + hashtags for this item.\n\nValidated attributes (the ONLY allowed facts):\n${facts}`
        : `Your previous response violated the platform constraints (Facebook title ≤ ${FACEBOOK_TITLE_MAX_LENGTH}, Mercari title ≤ ${MERCARI_TITLE_MAX_LENGTH}, ≤ ${MERCARI_MAX_HASHTAGS} hashtags drawn only from the given facts, no attributes beyond the validated core, NO prices and NO numbers that do not appear in the given facts). Regenerate strictly using only these facts:\n${facts}`;

    const { object } = await generateObject({
      model: llmModel,
      schema: rawExportPacksSchema,
      system: EXPORT_PACK_SYSTEM_PROMPT,
      prompt: instruction,
    });
    return object as RawExportPacks;
  };
}
