import { resolveLanguageModel, resolveModelId } from "../llm";
import {
  type ExtractedAttributes,
  type ListingCopy,
  listingCopySchema,
} from "../pipeline/types";
import type { FewShotExamples } from "../rag";
import {
  EBAY_PLATFORM,
  EBAY_TITLE_MAX_LENGTH,
  ebayListingRawSchema,
  ebayListingSchema,
  type EbayListing,
  type RawEbayListing,
} from "./schema";

/**
 * Real eBay listing generation (issue #9). One Zod-validated attribute core →
 * an eBay title / item specifics / description / tags, grounded by pgvector
 * few-shot retrieval, validated against eBay constraints, and reconciled so no
 * attribute is invented beyond the validated `ExtractedAttributes` core.
 *
 * Mirrors `vision/extract.ts` + `rag/embedding.ts`:
 *  - the MODEL call is INJECTED (`generate`) and defaults to a lazy `generateObject`
 *    wrapper, so tests run fully offline (no network / key);
 *  - the FEW-SHOT grounding is INJECTED (`fewShot` directly, or a `retrieve` fn that
 *    the real path calls), defaulting to the real rag retrieval — fakeable in tests;
 *  - the returned listing ALWAYS satisfies the platform contract: title length is
 *    repaired deterministically and hallucinated brand/model is reconciled away, then
 *    the result is validated against `ebayListingSchema` and mapped onto `ListingCopy`.
 *
 * AGENTS.md: "OpenAI via the Vercel AI SDK … structured output via `generateObject`
 * + Zod." PRD: "Generation is grounded by pgvector retrieval (few-shot)" and
 * "per-platform output validated against platform constraints … no attributes
 * hallucinated beyond the validated core."
 */

/**
 * Current strong text model (overridable via `LISTING_MODEL` so the provider/model
 * stays swappable — AGENTS.md "env-configurable everything"). Confirm exact IDs
 * against live OpenAI docs at build time.
 */
export const DEFAULT_LISTING_MODEL = "gpt-5.5";

/** Default count of few-shot exemplars retrieved to ground the generation. */
export const DEFAULT_FEW_SHOT_COUNT = 5;

/**
 * The injectable model call. Given the validated attribute core + the retrieved
 * few-shot exemplars, it returns the structured eBay listing. The real wrapper drives
 * `generateObject` with `ebayListingSchema`; tests pass a fake. `attempt` lets the
 * real wrapper nudge the prompt on a constraint-repair retry.
 */
export type ListingGenerate = (args: {
  model: string;
  attributes: ExtractedAttributes;
  fewShot: FewShotExamples;
  attempt: number;
}) => Promise<RawEbayListing>;

/**
 * Injectable few-shot retrieval. Returns the grounding exemplars for these
 * attributes. When the experiment is explicitly enabled, it defaults to the real
 * DB-backed rag path; tests pass a fake so generation runs offline.
 */
export type RetrieveFewShot = (
  attributes: ExtractedAttributes,
) => Promise<FewShotExamples>;

export interface ListingExampleRetrievalOptions {
  /** Explicit experiment gate. Omitted means the server environment decides. */
  enabled?: boolean;
  /** Maximum time spent waiting for optional examples before generation continues. */
  timeoutMs?: number;
}

const DEFAULT_LISTING_EXAMPLE_RETRIEVAL_TIMEOUT_MS = 2_000;
const MAX_LISTING_EXAMPLE_RETRIEVAL_TIMEOUT_MS = 5_000;

export interface GenerateEbayListingInput {
  /** The Zod-validated attribute core. The ONLY source of truth for facts. */
  attributes: ExtractedAttributes;
  /**
   * Grounding exemplars. Provide `fewShot` directly (already retrieved), OR a
   * `retrieve` fn the generator calls. If neither is given and the experiment is
   * enabled, the real rag retrieval is used. Retrieval stays off by default.
   */
  fewShot?: FewShotExamples;
  /** Injectable retrieval; called when `fewShot` is not supplied. */
  retrieve?: RetrieveFewShot;
  /** Server-side experiment policy. Retrieval is disabled unless explicitly enabled. */
  listingExampleRetrieval?: ListingExampleRetrievalOptions;
  /** Injected model call. Defaults to the real lazy `generateObject` wrapper. */
  generate?: ListingGenerate;
  /** Constraint-repair retries before giving up and repairing deterministically. Default 1. */
  maxRetries?: number;
  /** Model id override (else `LISTING_MODEL` env, else `DEFAULT_LISTING_MODEL`). */
  model?: string;
}

export interface GenerateEbayListingResult {
  /** The validated, platform-shaped eBay listing (passed `ebayListingSchema`). */
  listing: EbayListing;
  /** The same listing mapped onto the generic, persistable `ListingCopy` seam. */
  copy: ListingCopy;
  /** The model id used (logged for evaluation). */
  model: string;
}

// ---------------------------------------------------------------------------
// No-hallucination guard: every STRUCTURED fact in the generated listing must trace
// back to the validated attribute core. The returned item specifics are WHITELISTED to
// exactly the core-backed set, so the model cannot introduce a specific (Color, Storage
// Capacity, Manufacturer, a contradicting Brand/Model, …) the core never established.
// `listingHallucinatesAttributes` additionally lets us nudge the model to self-correct
// via a retry before the deterministic whitelist guarantees a clean result.
// ---------------------------------------------------------------------------

/**
 * The attribute keys that, when present in the core, ARE allowed (and expected) to
 * appear as eBay item specifics. Anything outside this set in the core is ignored for
 * reconciliation; anything the model emits beyond it is treated with suspicion.
 */
function coreSpecifics(attrs: ExtractedAttributes): Record<string, string> {
  const out: Record<string, string> = {};
  if (attrs.brand) out["Brand"] = attrs.brand;
  if (attrs.model) out["Model"] = attrs.model;
  if (attrs.category) out["Type"] = attrs.category;
  if (attrs.condition) out["Condition"] = attrs.condition;
  return out;
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Does the generated listing introduce a brand or model NOT present in the validated
 * core? A non-empty core `brand`/`model` that the listing's structured specifics
 * CONTRADICT (a different non-empty value) is a hallucination. A core that is silent on
 * brand/model must NOT gain one from the model out of thin air either — so a structured
 * `Brand`/`Model` specific whose value is absent from the core is rejected.
 */
export function listingHallucinatesAttributes(
  listing: EbayListing,
  attrs: ExtractedAttributes,
): boolean {
  const specifics = listing.itemSpecifics;
  for (const key of ["Brand", "Model"] as const) {
    const emitted = specifics[key];
    if (emitted == null || norm(emitted) === "") continue;
    const coreValue = key === "Brand" ? attrs.brand : attrs.model;
    // The model asserted a brand/model the core never established, or one that
    // disagrees with it → invented fact.
    if (!coreValue || norm(coreValue) !== norm(emitted)) return true;
  }
  return false;
}

/**
 * Reconcile the listing's STRUCTURED specifics to ONLY what the validated core backs.
 * eBay item specifics are the load-bearing, buyer-filterable facts, so the
 * "no attributes beyond the validated core" rule is enforced deterministically here:
 * the returned specifics are EXACTLY the core-backed set (`coreSpecifics`). Any specific
 * the model emitted under a key the core never established — `Color`, `Storage Capacity`,
 * `Manufacturer`, a contradicting `Brand`/`Model`, … — is an invented attribute and is
 * dropped (not just brand/model). Free-text title/description/tags stay stylistic; the
 * prompt forbids invented facts there and they are not buyer-filterable structured claims.
 */
function reconcileSpecifics(attrs: ExtractedAttributes): Record<string, string> {
  // Whitelist: the core is the ONLY source of truth for structured specifics.
  return coreSpecifics(attrs);
}

// ---------------------------------------------------------------------------
// Title-length guarantee: deterministic truncation on a word boundary, with an
// ellipsis when the cut lands mid-content. Applied unconditionally so the RETURNED
// listing always satisfies the cap regardless of what the model produced.
// ---------------------------------------------------------------------------

/**
 * Truncate a title to the eBay cap deterministically, preferring a word boundary so
 * the result stays readable. Idempotent for already-valid titles.
 */
export function enforceTitleLength(
  title: string,
  max: number = EBAY_TITLE_MAX_LENGTH,
): string {
  const trimmed = title.trim();
  if (trimmed.length <= max) return trimmed;
  const hardCut = trimmed.slice(0, max);
  const lastSpace = hardCut.lastIndexOf(" ");
  // Keep at least half the budget before falling back to a hard character cut.
  const cut = lastSpace > max / 2 ? hardCut.slice(0, lastSpace) : hardCut;
  return cut.trimEnd();
}

// ---------------------------------------------------------------------------
// The generation entrypoint
// ---------------------------------------------------------------------------

function resolveModel(model?: string): string {
  return resolveModelId("listing", { modelId: model });
}

/**
 * Map a validated eBay listing onto the generic, persistable `ListingCopy` seam. The
 * item specifics + tags ride in `fields` (matching the `listings.copy` JSONB shape).
 */
export function toListingCopy(listing: EbayListing): ListingCopy {
  return listingCopySchema.parse({
    platform: EBAY_PLATFORM,
    title: listing.title,
    description: listing.description,
    fields: {
      itemSpecifics: listing.itemSpecifics,
      tags: listing.tags,
    },
  });
}

/**
 * Generate a validated, grounded eBay listing from the attribute core.
 *
 * Flow per attempt: call the injected `generate` with the core + few-shot exemplars,
 * deterministically enforce the title cap, reconcile the structured specifics back to
 * the core. If the candidate STILL hallucinates identity attributes (a brand/model the
 * core never established), retry to give the model a chance to comply; on the final
 * attempt the reconciliation guarantees a clean listing. Always validates against
 * `ebayListingSchema` before mapping onto `ListingCopy`.
 */
export async function generateEbayListing(
  input: GenerateEbayListingInput,
): Promise<GenerateEbayListingResult> {
  const { attributes, maxRetries = 1 } = input;
  const model = resolveModel(input.model);
  const generate = input.generate ?? createOpenAIListingGenerate();

  // Resolve the grounding few-shot: explicit > injected retrieve > real rag path.
  const fewShot = input.fewShot ?? (await resolveFewShot(input, attributes));

  const attempts = maxRetries + 1;
  let lastError = "";
  let lastReconciled: EbayListing | null = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let raw: RawEbayListing;
    try {
      raw = await generate({ model, attributes, fewShot, attempt });
    } catch (err) {
      // The real `generateObject` THROWS on a schema-invalid response rather than
      // returning one. Treat a throw as a failed attempt and retry; only give up
      // once attempts are exhausted (mirrors vision/extract).
      lastError = err instanceof Error ? err.message : String(err);
      continue;
    }

    // Deterministic constraint repair: title length + structured-specifics
    // reconciliation. After this, the candidate cannot violate the title cap and its
    // identity specifics cannot contradict / exceed the core.
    const reconciled: EbayListing = {
      ...raw,
      title: enforceTitleLength(raw.title),
      itemSpecifics: reconcileSpecifics(attributes),
    };

    const parsed = ebayListingSchema.safeParse(reconciled);
    if (!parsed.success) {
      lastError = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      continue;
    }
    lastReconciled = parsed.data;

    // If the RAW model output tried to invent identity attributes, prefer a retry so
    // the model can self-correct; the reconciled candidate is already clean, so we
    // keep it as the fallback for the final attempt.
    if (listingHallucinatesAttributes(raw, attributes) && attempt < attempts - 1) {
      lastError = "generated listing introduced attributes beyond the validated core";
      continue;
    }

    return {
      listing: parsed.data,
      copy: toListingCopy(parsed.data),
      model,
    };
  }

  // All attempts exhausted. If we have a reconciled candidate (the guard kept retrying
  // on hallucination but each pass was already cleaned), return it — it provably
  // satisfies the contract. Otherwise the model never produced anything usable.
  if (lastReconciled) {
    return {
      listing: lastReconciled,
      copy: toListingCopy(lastReconciled),
      model,
    };
  }

  throw new Error(
    `eBay listing generation failed after ${attempts} attempt(s). Last error: ${lastError}`,
  );
}

/**
 * Resolve optional few-shot grounding when not provided directly. Disabled and
 * unusable retrieval both normalize to the same no-examples result.
 */
function noListingExamples(): FewShotExamples {
  return { matches: [], examples: [] };
}

function isFewShotExamples(value: unknown): value is FewShotExamples {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FewShotExamples>;
  return (
    Array.isArray(candidate.matches) &&
    Array.isArray(candidate.examples) &&
    candidate.matches.length === candidate.examples.length &&
    candidate.examples.every(
      (example, index) =>
        typeof example === "string" &&
        candidate.matches?.[index]?.content === example,
    )
  );
}

async function resolveFewShot(
  input: GenerateEbayListingInput,
  attributes: ExtractedAttributes,
): Promise<FewShotExamples> {
  const enabled =
    input.listingExampleRetrieval?.enabled ??
    process.env.LISTING_EXAMPLE_RETRIEVAL_ENABLED === "true";
  if (!enabled) return noListingExamples();
  const configuredTimeout =
    input.listingExampleRetrieval?.timeoutMs ??
    Number(process.env.LISTING_EXAMPLE_RETRIEVAL_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configuredTimeout) && configuredTimeout > 0
      ? Math.min(configuredTimeout, MAX_LISTING_EXAMPLE_RETRIEVAL_TIMEOUT_MS)
      : DEFAULT_LISTING_EXAMPLE_RETRIEVAL_TIMEOUT_MS;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const retrieve = input.retrieve ?? createRealFewShotRetrieval();
    const retrieved: unknown = await Promise.race([
      retrieve(attributes),
      new Promise<FewShotExamples>((resolve) => {
        timeout = setTimeout(() => resolve(noListingExamples()), timeoutMs);
      }),
    ]);
    return isFewShotExamples(retrieved) ? retrieved : noListingExamples();
  } catch {
    return noListingExamples();
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Real grounding (rag) + real OpenAI generate — lazy, env-gated. Used only when
// nothing is injected. Never imported by the offline tests.
// ---------------------------------------------------------------------------

/**
 * Build the real few-shot retrieval: embed the attribute core, run the pgvector
 * `match_reference_corpus` RPC via `retrieveReferences`, and shape the matches into
 * exemplars with `fewShotExamples`. Requires Supabase URL + key and (optionally) an
 * OpenAI key for embeddings in the environment.
 */
/**
 * The Supabase key for the request-path corpus read. The reference corpus is
 * GLOBAL, anon-readable reference data (SELECT policies for both `anon` and
 * `authenticated`; no write policy) and the RPC is SECURITY INVOKER — so the ANON
 * key suffices. We deliberately do NOT fall back to the SERVICE-ROLE key here:
 * this runs inside the authenticated upload request, and a service-role client
 * bypasses RLS, which must never happen on a per-user request path (#57). Exported
 * so the "never service role" property is unit-tested.
 */
export function corpusReadKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return env.SUPABASE_ANON_KEY ?? env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
}

export function createRealFewShotRetrieval(): RetrieveFewShot {
  return async (attributes) => {
    const [{ createClient }, rag] = await Promise.all([
      import("@supabase/supabase-js"),
      import("../rag"),
    ]);
    const url =
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = corpusReadKey();
    if (!url || !key) {
      throw new Error(
        "Real few-shot retrieval needs SUPABASE_URL + a Supabase key; inject `fewShot` or `retrieve` for offline use.",
      );
    }
    const client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const embedder = rag.selectEmbedder({ OPENAI_API_KEY: process.env.OPENAI_API_KEY });
    const matches = await rag.retrieveReferences(
      client,
      {
        brand: attributes.brand,
        model: attributes.model,
        category: attributes.category,
        text: attributes.title,
      },
      embedder,
      { matchCount: DEFAULT_FEW_SHOT_COUNT },
    );
    return rag.fewShotExamples(matches);
  };
}

/**
 * System guidance: write a competent eBay listing GROUNDED in the exemplars, using
 * ONLY the supplied attribute facts. The hard no-hallucination instruction is the
 * prompt-side complement to the code-side reconciliation guard.
 */
const LISTING_SYSTEM_PROMPT =
  "You write competent, native-looking eBay listings for used items. Use ONLY the " +
  "supplied attribute facts (brand, model, category, condition, specs) — never invent " +
  "a brand, model, or spec that is not given. Ground your tone and structure in the " +
  "provided example listings. The title must be a keyword-dense eBay title of 80 " +
  "characters or fewer. Provide eBay item specifics as name→value pairs drawn from the " +
  "given attributes, a clear description, and relevant search tags.";

/**
 * Build the real generate: a lazy wrapper around the AI SDK's `generateObject` with
 * `schema: ebayListingSchema`. Imported lazily (like `embedding.ts` / `extract.ts`) so
 * the SDK never loads on the offline test path. The model is resolved through the LLM
 * provider registry (`resolveLanguageModel("listing", …)`), so the provider/key follow
 * `LLM_PROVIDER`; `apiKey`, when supplied, overrides the registry-resolved key.
 */
export function createOpenAIListingGenerate(
  apiKey: string | undefined = undefined,
): ListingGenerate {
  return async ({ model, attributes, fewShot, attempt }) => {
    const { generateObject } = await import("ai");
    const llmModel = await resolveLanguageModel("listing", { modelId: model, apiKey });

    const examples = fewShot.examples
      .map((e, i) => `Example ${i + 1}:\n${e}`)
      .join("\n\n");
    const facts = JSON.stringify(attributes, null, 2);
    const instruction =
      attempt === 0
        ? `Write an eBay listing for this item.\n\nValidated attributes (the ONLY allowed facts):\n${facts}\n\nGrounding example listings:\n${examples}`
        : `Your previous response violated the eBay constraints (title length ≤ ${EBAY_TITLE_MAX_LENGTH}, no attributes beyond the validated core). Regenerate strictly using only these facts:\n${facts}`;

    // Generate against the PERMISSIVE schema so a merely over-long title or empty
    // specifics is RETURNED (not thrown by the SDK) and reaches the deterministic
    // repair/whitelist; the repaired candidate is then validated against the strict
    // `ebayListingSchema` in `generateEbayListing`.
    const { object } = await generateObject({
      model: llmModel,
      schema: ebayListingRawSchema,
      system: LISTING_SYSTEM_PROMPT,
      prompt: instruction,
    });
    return object as RawEbayListing;
  };
}
