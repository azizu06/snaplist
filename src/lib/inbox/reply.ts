import { z } from "zod";
import type { ReplyGrounding } from "./types";
import { itemLabel } from "./simulate";

/**
 * Buyer-Q&A reply agent (issue #13). Drafts a seller reply to a buyer question,
 * GROUNDED EXCLUSIVELY in the item's validated attributes + generated listing copy
 * (`ReplyGrounding`). Mirrors `listing/generate.ts`:
 *
 *  - the MODEL call is INJECTED (`generate`) and defaults to a lazy `generateObject`
 *    wrapper, so tests run fully offline (no network / key);
 *  - the model id is overridable via `REPLY_MODEL` (AGENTS.md "env-configurable
 *    everything"), defaulting like LISTING_MODEL does;
 *  - the prompt forbids invented facts AND a deterministic code-side guard
 *    (`replyAssertsUngroundedNumbers`) rejects replies that assert numeric claims
 *    (prices, counts, timings, measurements) absent from the grounding itself;
 *  - the agent NEVER throws on model failure: after retries it falls back to a
 *    deterministic reply built ONLY from the grounding, so the inbox flow always
 *    produces a safe draft for the seller to edit.
 */

/** Current strong text model. Confirm exact IDs against live OpenAI docs. */
export const DEFAULT_REPLY_MODEL = "gpt-5.5";

/**
 * What the model must return. `answerable: false` is the model's own signal that
 * the grounding does not contain the fact the buyer asked about — the agent then
 * uses the deterministic "let me check and get back to you" reply instead of
 * letting the model improvise an answer.
 */
export const buyerReplyRawSchema = z.object({
  reply: z.string(),
  answerable: z.boolean(),
});

export type RawBuyerReply = z.infer<typeof buyerReplyRawSchema>;

/**
 * The injectable model call. Given the buyer question + the grounding, returns the
 * structured draft. The real wrapper drives `generateObject` with
 * `buyerReplyRawSchema`; tests pass a fake. `attempt` lets the real wrapper nudge
 * the prompt on a grounding-violation retry.
 */
export type ReplyGenerate = (args: {
  model: string;
  question: string;
  grounding: ReplyGrounding;
  attempt: number;
}) => Promise<RawBuyerReply>;

export interface DraftBuyerReplyInput {
  /** The buyer's question (the inbound message body). */
  question: string;
  /** The ONLY facts the reply may use. */
  grounding: ReplyGrounding;
  /** Injected model call. Defaults to the real lazy `generateObject` wrapper. */
  generate?: ReplyGenerate;
  /** Model id override (else `REPLY_MODEL` env, else `DEFAULT_REPLY_MODEL`). */
  model?: string;
  /** Grounding-violation retries before the deterministic fallback. Default 1. */
  maxRetries?: number;
}

export interface DraftBuyerReplyResult {
  /** The draft reply — model-written and guard-checked, or the deterministic fallback. */
  reply: string;
  /** The model id used (provenance, persisted as `messages.draft_model`). */
  model: string;
  /** True when the deterministic grounded fallback was used instead of model output. */
  usedFallback: boolean;
}

// ---------------------------------------------------------------------------
// Grounding corpus + the deterministic no-hallucination guard.
// ---------------------------------------------------------------------------

/**
 * Flatten EVERYTHING the reply is allowed to reference into one searchable string:
 * the validated attribute values + the listing title/description (which carries
 * the stored price). The buyer's question is deliberately EXCLUDED: a number the
 * buyer introduced is an unverified premise, not a grounded fact — "Can you ship
 * in 2 days?" must never license "Yes, I can ship in 2 days."
 */
export function groundingCorpus(grounding: ReplyGrounding): string {
  const { attributes, listing } = grounding;
  const parts: string[] = [];
  for (const value of Object.values(attributes)) {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) parts.push(...value);
  }
  if (listing) parts.push(listing.title, listing.description);
  return parts.join("\n").toLowerCase();
}

/**
 * Whole alphanumeric tokens, lowercased. Hyphens/dots/commas join a token only
 * when alphanumerics sit on BOTH sides, so `WH-1000XM4` → `wh-1000xm4`,
 * `1,000` → `1,000`, but a trailing period or a comma before a space never
 * glues words together.
 */
const TOKEN_RE = /[a-z0-9]+(?:[-.,][a-z0-9]+)*/g;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

/** A token that is a number on its own (digits, optional commas/decimal). */
function isStandaloneNumber(token: string): boolean {
  return /^\d[\d,]*(?:\.\d+)?$/.test(token);
}

/** Normalize a standalone number for comparison (commas stripped). */
function normalizeNumber(token: string): string {
  return token.replace(/,/g, "");
}

/** A token plus whether it was currency-marked ("$45") in the source text. */
interface TokenInfo {
  token: string;
  currency: boolean;
}

function tokenInfos(text: string): TokenInfo[] {
  const lower = text.toLowerCase();
  const infos: TokenInfo[] = [];
  for (const m of lower.matchAll(TOKEN_RE)) {
    infos.push({
      token: m[0],
      currency: m.index != null && m.index > 0 && lower[m.index - 1] === "$",
    });
  }
  return infos;
}

/** How many tokens on each side of a number count as its claim context. */
const NUMBER_CONTEXT_WINDOW = 2;

/** What the grounding licenses each standalone number to be used FOR. */
interface NumberGrounding {
  /** Numbers the corpus carries with a currency marker ("$180"). */
  currencyNumbers: Set<string>;
  /** normalized number → the non-number tokens near it in the corpus (its claim context). */
  contexts: Map<string, Set<string>>;
  /**
   * Numbers that occur context-free in some grounding part (e.g. an attribute
   * value that is just "45") — there is no context to bind, so any use passes.
   */
  contextFree: Set<string>;
}

/**
 * Collect, per grounding PART (parts never share a sentence, so windows must
 * not cross part boundaries), the context tokens around every standalone
 * number plus the set of currency-marked numbers.
 */
function collectNumberGrounding(parts: readonly string[]): NumberGrounding {
  const currencyNumbers = new Set<string>();
  const contexts = new Map<string, Set<string>>();
  const contextFree = new Set<string>();
  for (const part of parts) {
    const infos = tokenInfos(part);
    infos.forEach((info, i) => {
      if (!isStandaloneNumber(info.token)) return;
      const key = normalizeNumber(info.token);
      if (info.currency) currencyNumbers.add(key);
      let added = 0;
      let ctx = contexts.get(key);
      for (
        let j = Math.max(0, i - NUMBER_CONTEXT_WINDOW);
        j <= Math.min(infos.length - 1, i + NUMBER_CONTEXT_WINDOW);
        j++
      ) {
        if (j === i) continue;
        if (isStandaloneNumber(infos[j].token)) continue; // numbers don't vouch for numbers
        if (!ctx) {
          ctx = new Set();
          contexts.set(key, ctx);
        }
        ctx.add(infos[j].token);
        added += 1;
      }
      if (added === 0 && !info.currency) contextFree.add(key);
    });
  }
  return { currencyNumbers, contexts, contextFree };
}

/**
 * Does the reply ASSERT a numeric claim (a price, a timing, a count, a spec
 * measurement) that appears nowhere in the grounding corpus? Numbers are the
 * highest-risk hallucination class for marketplace replies ("I'll ship in 2 days",
 * "it retails for $349") and — unlike prose — are deterministically checkable.
 *
 * Grounding is CONTEXTUAL at token boundaries — digits are never treated as a
 * global allowlist. A digit-bearing token in the reply is grounded ONLY when:
 *
 *  (a) it is an alphanumeric token (`wh-1000xm4`, `128gb`) that appears as a
 *      WHOLE token (case-insensitive) in the corpus; or
 *  (b) it is a STANDALONE number that appears as a standalone number in the
 *      corpus AND the reply uses it for the SAME CLAIM: a currency-marked
 *      reply number ("$45") matches a currency-marked corpus number, and any
 *      other reply number must share at least one nearby non-number token
 *      with the corpus occurrence ("2 controllers" ↔ "comes with 2
 *      controllers"). The mere presence of a `2` in the grounding never
 *      licenses "I can ship in 2 days" — counts cannot be repurposed as
 *      timings, prices, or specs.
 *
 * Digits mined out of identifiers never license standalone numbers: a grounding
 * `WH-1000XM4` does NOT make "I can ship in 4 days" pass. Numbers the BUYER used
 * are still not grounded facts (the question is excluded from the corpus), so a
 * reply echoing them as assertions is rejected (→ retry, then deterministic
 * fallback). The asymmetry is deliberate: a true-but-rejected number only costs
 * a retry/fallback, while an accepted hallucination ships to a buyer.
 */
export function replyAssertsUngroundedNumbers(
  reply: string,
  grounding: ReplyGrounding,
): boolean {
  const parts = groundingCorpus(grounding).split("\n");
  const allowedTokens = new Set(parts.flatMap(tokenize));
  const numbers = collectNumberGrounding(parts);

  const replyInfos = tokenInfos(reply);
  return replyInfos.some((info, i) => {
    if (!/\d/.test(info.token)) return false; // no numeric claim in this token
    if (!isStandaloneNumber(info.token)) return !allowedTokens.has(info.token);

    const key = normalizeNumber(info.token);
    if (info.currency && numbers.currencyNumbers.has(key)) return false;
    if (numbers.contextFree.has(key)) return false;
    const corpusCtx = numbers.contexts.get(key);
    if (!corpusCtx) return true; // number absent from the grounding entirely
    for (
      let j = Math.max(0, i - NUMBER_CONTEXT_WINDOW);
      j <= Math.min(replyInfos.length - 1, i + NUMBER_CONTEXT_WINDOW);
      j++
    ) {
      if (j === i) continue;
      if (corpusCtx.has(replyInfos[j].token)) return false; // same claim context
    }
    return true;
  });
}

/**
 * The deterministic, provably-grounded fallback. EVERY fact in it traces to the
 * grounding object: the item label (brand/model/title) and, when known, the
 * condition. Anything the grounding cannot answer is deferred, never invented.
 */
export function fallbackBuyerReply(grounding: ReplyGrounding): string {
  const label = itemLabel(grounding);
  const condition = grounding.attributes.condition;
  const conditionLine = condition
    ? ` It is in ${condition} condition, as described in the listing.`
    : "";
  return (
    `Thanks for your interest in ${label}!${conditionLine} ` +
    "Let me double-check the details on your question and get back to you shortly."
  );
}

// ---------------------------------------------------------------------------
// The drafting entrypoint
// ---------------------------------------------------------------------------

function resolveModel(model?: string): string {
  return model?.trim() || process.env.REPLY_MODEL?.trim() || DEFAULT_REPLY_MODEL;
}

/**
 * Draft a grounded reply to a buyer question.
 *
 * Flow per attempt: call the injected `generate` with the question + grounding; a
 * thrown error or empty reply is a failed attempt; a reply that asserts
 * ungrounded numbers triggers a retry. When attempts are exhausted (or the model
 * itself declared the question unanswerable from the grounding), the
 * deterministic grounded fallback is returned — this function NEVER throws, so the
 * simulated-inbox flow always yields a safe draft for the seller to edit.
 */
export async function draftBuyerReply(
  input: DraftBuyerReplyInput,
): Promise<DraftBuyerReplyResult> {
  const { question, grounding, maxRetries = 1 } = input;
  const model = resolveModel(input.model);
  const generate = input.generate ?? createOpenAIReplyGenerate();

  const attempts = maxRetries + 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let raw: RawBuyerReply;
    try {
      raw = await generate({ model, question, grounding, attempt });
    } catch {
      // Model/transport failure → retry, then fall back. Never propagate: a dead
      // LLM must not break the inbox demo (the fallback is always available).
      continue;
    }

    const parsed = buyerReplyRawSchema.safeParse(raw);
    if (!parsed.success) continue;

    // The model says the grounding can't answer this — don't let it improvise.
    if (!parsed.data.answerable) break;

    const reply = parsed.data.reply.trim();
    if (reply === "") continue;

    // Deterministic guard: an asserted number that does not trace to the grounding
    // (attributes + listing copy) is an invented/unverified fact → retry / fall
    // back. Numbers from the buyer's question are NOT allowed — see the guard doc.
    if (replyAssertsUngroundedNumbers(reply, grounding)) continue;

    return { reply, model, usedFallback: false };
  }

  return { reply: fallbackBuyerReply(grounding), model, usedFallback: true };
}

// ---------------------------------------------------------------------------
// Real OpenAI generate — lazy, env-gated. Used only when nothing is injected.
// Never imported by the offline tests.
// ---------------------------------------------------------------------------

/**
 * System guidance: answer as the seller using ONLY the supplied facts. The hard
 * no-invention instruction is the prompt-side complement to the code-side numeric
 * guard + fallback.
 */
const REPLY_SYSTEM_PROMPT =
  "You draft a seller's reply to a buyer question about a used-item marketplace " +
  "listing. Use ONLY the supplied item facts and listing copy — NEVER invent a " +
  "price, shipping time, dimension, accessory, or any spec that is not given. Do " +
  "not state any number that does not appear in the facts or the listing — a " +
  "number the buyer used in their question is NOT a verified fact and must not " +
  "be asserted back. If the supplied facts cannot answer the question, set " +
  "answerable to false instead of guessing. Keep the reply friendly, concise " +
  "(under 120 words), and ready to send as-is.";

/**
 * Build the real generate: a lazy wrapper around the AI SDK's `generateObject`
 * with `schema: buyerReplyRawSchema`. Imported lazily (like listing/generate.ts)
 * so the SDK never loads on the offline test path. `apiKey` defaults to
 * OPENAI_API_KEY.
 */
export function createOpenAIReplyGenerate(
  apiKey: string | undefined = process.env.OPENAI_API_KEY,
): ReplyGenerate {
  return async ({ model, question, grounding, attempt }) => {
    const [{ generateObject }, { createOpenAI }] = await Promise.all([
      import("ai"),
      import("@ai-sdk/openai"),
    ]);
    const openai = createOpenAI(apiKey ? { apiKey } : {});

    const facts = JSON.stringify(grounding.attributes, null, 2);
    const listing = grounding.listing
      ? `Listing title: ${grounding.listing.title}\nListing description:\n${grounding.listing.description}`
      : "No listing copy is available for this item.";
    const instruction =
      attempt === 0
        ? `Buyer question:\n${question}\n\nValidated item facts (the ONLY allowed facts):\n${facts}\n\n${listing}`
        : `Your previous reply asserted facts (numbers) that are not in the supplied grounding. Regenerate strictly using only the given facts.\n\nBuyer question:\n${question}\n\nValidated item facts:\n${facts}\n\n${listing}`;

    const { object } = await generateObject({
      model: openai.chat(model),
      schema: buyerReplyRawSchema,
      system: REPLY_SYSTEM_PROMPT,
      prompt: instruction,
    });
    return object;
  };
}
