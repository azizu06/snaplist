import type { ReplyGrounding } from "./types";

/**
 * Simulated buyer questions (issue #13). v1 has no real buyer traffic — the PRD
 * keeps messaging simulated until the eBay adapter (issue #14) — so the inbox is
 * demonstrated by GENERATING a plausible buyer question about a real item.
 *
 * Pure and deterministic under an injected `random`, so tests assert exact
 * outputs offline. Questions reference the item's ACTUAL facts (brand, model,
 * condition, specs) when present, falling back to generic marketplace questions
 * so any item — including a low-confidence generic one — still produces a
 * sensible message.
 */

/** Injectable randomness: a fn returning [0, 1). Defaults to Math.random. */
export type RandomFn = () => number;

/** A short human label for the item, from its strongest available identifiers. */
export function itemLabel(grounding: ReplyGrounding): string {
  const { attributes, listing } = grounding;
  const brandModel = [attributes.brand, attributes.model]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join(" ");
  return brandModel || attributes.title || listing?.title || "the item";
}

/**
 * Build the candidate question pool for this item. Attribute-specific questions
 * are only offered when the underlying fact exists, so every candidate is
 * answerable-from-grounding by construction (the reply agent still re-verifies).
 */
export function buyerQuestionCandidates(grounding: ReplyGrounding): string[] {
  const { attributes } = grounding;
  const label = itemLabel(grounding);

  const candidates: string[] = [
    `Hi! Is the ${label} still available?`,
    `How soon can you ship the ${label} after purchase?`,
    `Would you consider a slightly lower price on the ${label}?`,
  ];

  if (attributes.condition) {
    candidates.push(
      `The listing says the condition is "${attributes.condition}" — can you tell me more about any wear or damage?`,
    );
  }
  if (attributes.brand && attributes.model) {
    candidates.push(
      `Is this a genuine ${attributes.brand} ${attributes.model}? Does it come with the original packaging?`,
    );
  }
  const firstSpec = attributes.specs?.[0];
  if (firstSpec) {
    candidates.push(
      `The listing mentions "${firstSpec}" — can you confirm that works as expected?`,
    );
  }

  return candidates;
}

/**
 * Pick one simulated buyer question for the item. `random` is injectable for
 * deterministic tests; the real route uses the default.
 */
export function simulateBuyerQuestion(
  grounding: ReplyGrounding,
  random: RandomFn = Math.random,
): string {
  const candidates = buyerQuestionCandidates(grounding);
  const index = Math.min(
    candidates.length - 1,
    Math.max(0, Math.floor(random() * candidates.length)),
  );
  return candidates[index];
}
