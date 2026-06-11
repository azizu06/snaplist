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
 *    (prices, counts, timings, measurements) absent from the grounding + question;
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
 * the validated attribute values + the listing title/description + the buyer's own
 * question (a reply may legitimately echo a number the buyer used).
 */
export function groundingCorpus(question: string, grounding: ReplyGrounding): string {
  const { attributes, listing } = grounding;
  const parts: string[] = [question];
  for (const value of Object.values(attributes)) {
    if (typeof value === "string") parts.push(value);
    else if (Array.isArray(value)) parts.push(...value);
  }
  if (listing) parts.push(listing.title, listing.description);
  return parts.join("\n").toLowerCase();
}

/** Extract normalized numeric tokens (commas stripped) from free text. */
function numericTokens(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((t) => t.replace(/,/g, ""));
}

/**
 * Does the reply ASSERT a numeric claim (a price, a timing, a count, a spec
 * measurement) that appears nowhere in the grounding corpus? Numbers are the
 * highest-risk hallucination class for marketplace replies ("I'll ship in 2 days",
 * "it retails for $349") and — unlike prose — are deterministically checkable.
 * Free-text wording stays the prompt's job; the fallback covers the rest.
 */
export function replyAssertsUngroundedNumbers(
  reply: string,
  question: string,
  grounding: ReplyGrounding,
): boolean {
  const corpus = numericTokens(groundingCorpus(question, grounding));
  const allowed = new Set(corpus);
  return numericTokens(reply).some((token) => !allowed.has(token));
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

    // Deterministic guard: an asserted number that traces to neither the grounding
    // nor the buyer's own question is an invented fact → retry / fall back.
    if (replyAssertsUngroundedNumbers(reply, question, grounding)) continue;

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
  "not state any number that does not appear in the facts, the listing, or the " +
  "buyer's question. If the supplied facts cannot answer the question, set " +
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
