import { z } from "zod";

/** Bump only when authorization behavior changes; decisions are unique per version. */
export const MESSAGE_POLICY_VERSION = "grounded-pre-sale-v3";

export const messagePolicyOutcomeSchema = z.enum([
  "auto_send",
  "draft_for_approval",
  "escalate",
]);
export type MessagePolicyOutcome = z.infer<typeof messagePolicyOutcomeSchema>;

export const messagePolicyReasonSchema = z.enum([
  "exact_authoritative_fact",
  "preference_disabled",
  "negotiation_requires_seller",
  "seller_commitment_required",
  "untrusted_instruction",
  "post_sale_out_of_scope",
  "listing_not_authoritatively_active",
  "authoritative_facts_stale",
  "authoritative_facts_conflict",
  "authoritative_fact_missing",
  "ambiguous_question",
]);
export type MessagePolicyReason = z.infer<typeof messagePolicyReasonSchema>;

export const authoritativeFactSourceSchema = z.enum([
  "active_listing_specific",
  "seller_confirmed_measurement",
  "current_asking_price",
  "active_listing_state",
  "seller_approved_policy",
]);
export type AuthoritativeFactSource = z.infer<
  typeof authoritativeFactSourceSchema
>;

export const authoritativeFactSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  source: authoritativeFactSourceSchema,
  reference: z.string().min(1),
});
export type AuthoritativeFact = z.infer<typeof authoritativeFactSchema>;

export const authoritativeMessageGroundingSchema = z.object({
  listingId: z.uuid(),
  active: z.boolean(),
  current: z.boolean(),
  conflicts: z.array(z.string()),
  facts: z.array(authoritativeFactSchema),
  authorization: z.object({
    listingUpdatedAt: z.string().datetime({ offset: true }),
    itemUpdatedAt: z.string().datetime({ offset: true }),
    marketplaceObservedAt: z.string().datetime({ offset: true }),
    externalListingId: z.string().min(1),
  }),
});
export type AuthoritativeMessageGrounding = z.infer<
  typeof authoritativeMessageGroundingSchema
>;

export const messagePolicySignalsSchema = z.object({
  preferenceEnabled: z.boolean(),
  buyerTextTreatedAsUntrusted: z.literal(true),
  authoritativeFactMatched: z.boolean(),
  activeListing: z.boolean(),
  factsCurrent: z.boolean(),
  conflictsAbsent: z.boolean(),
});

export const messagePolicyResultSchema = z.object({
  policyVersion: z.literal(MESSAGE_POLICY_VERSION),
  outcome: messagePolicyOutcomeSchema,
  reasonCodes: z.array(messagePolicyReasonSchema).min(1),
  groundingReferences: z.array(authoritativeFactSchema),
  signals: messagePolicySignalsSchema,
  proposedReply: z.string().min(1).max(2_000).nullable(),
  authorization: authoritativeMessageGroundingSchema.shape.authorization,
});
export type MessagePolicyResult = z.infer<typeof messagePolicyResultSchema>;

export interface MessagePolicyAuditRecord extends MessagePolicyResult {
  id: string;
  messageId: string;
  draftReply: string;
  draftModel: string;
  deliveryStatus: string;
  decidedAt: string;
}

export interface DecideMessagePolicyInput {
  enabled: boolean;
  question: string;
  grounding: AuthoritativeMessageGrounding;
}

const INJECTION_RE =
  /\b(ignore|disregard|override|forget)\b.{0,32}\b(instructions?|polic(?:y|ies)|prompts?|rules?|system)\b|\b(system prompt|developer message|jailbreak)\b/i;
const NEGOTIATION_RE =
  /\b(offer|discount|lowest|best price|take \$?|accept \$?|counter|negotiate|firm on price|deal)\b/i;
const COMMITMENT_RE =
  /\b(ship|shipping|deliver|delivery|returns?|refund|warranty|guarantee|promise|hold it|reserve)\b/i;
const POST_SALE_RE =
  /\b(order|tracking|payment|paid|refund status|dispute|chargeback|received|arrived)\b/i;

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function signals(
  enabled: boolean,
  grounding: AuthoritativeMessageGrounding,
  matched: boolean,
) {
  return {
    preferenceEnabled: enabled,
    buyerTextTreatedAsUntrusted: true as const,
    authoritativeFactMatched: matched,
    activeListing: grounding.active,
    factsCurrent: grounding.current,
    conflictsAbsent: grounding.conflicts.length === 0,
  };
}

function result(
  input: DecideMessagePolicyInput,
  outcome: MessagePolicyOutcome,
  reason: MessagePolicyReason,
  fact: AuthoritativeFact | null = null,
  proposedReply: string | null = null,
): MessagePolicyResult {
  return messagePolicyResultSchema.parse({
    policyVersion: MESSAGE_POLICY_VERSION,
    outcome,
    reasonCodes: [reason],
    groundingReferences: fact ? [fact] : [],
    signals: signals(input.enabled, input.grounding, fact !== null),
    proposedReply,
    authorization: input.grounding.authorization,
  });
}

function factBySource(
  grounding: AuthoritativeMessageGrounding,
  source: AuthoritativeFactSource,
): AuthoritativeFact | null {
  return grounding.facts.find((fact) => fact.source === source) ?? null;
}

function factByKey(
  grounding: AuthoritativeMessageGrounding,
  keys: readonly string[],
): AuthoritativeFact | null {
  const wanted = new Set(keys.map(normalized));
  return grounding.facts.find((fact) => wanted.has(normalized(fact.key))) ?? null;
}

function exactFactAnswer(
  input: DecideMessagePolicyInput,
): { fact: AuthoritativeFact; reply: string } | null {
  const q = normalized(input.question);

  if (
    /^(is (this|it|the item) (still )?(available|for sale)|do you still have (this|it|the item))$/.test(
      q,
    )
  ) {
    const fact = factBySource(input.grounding, "active_listing_state");
    return fact
      ? { fact, reply: "Yes — this listing is currently active on eBay." }
      : null;
  }

  if (
    /^(what is the (current )?(asking )?price|what are you asking|how much is (it|this|the item))$/.test(
      q,
    )
  ) {
    const fact = factBySource(input.grounding, "current_asking_price");
    const price = fact ? Number(fact.value) : NaN;
    if (!fact?.currency || !Number.isFinite(price) || price <= 0) return null;
    try {
      const formatted = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: fact.currency,
        currencyDisplay: "symbol",
      }).format(price);
      return { fact, reply: `The current asking price is ${formatted}.` };
    } catch {
      return null;
    }
  }

  const fieldMatch = q.match(
    /^(what|which) (brand|model|condition|type|category|size|color)( is it| is this| is the item| does it have| is it in)?$/,
  );
  if (fieldMatch) {
    const key = fieldMatch[2];
    const aliases: Record<string, string[]> = {
      brand: ["brand"],
      model: ["model"],
      condition: ["condition"],
      type: ["type", "category"],
      category: ["category", "type"],
      size: ["size"],
      color: ["color"],
    };
    const fact = factByKey(input.grounding, aliases[key] ?? [key]);
    return fact ? { fact, reply: `${fact.key}: ${fact.value}.` } : null;
  }

  const measurement = input.grounding.facts.find(
    (fact) =>
      fact.source === "seller_confirmed_measurement" &&
      q.includes(normalized(fact.key)) &&
      /\b(measure|measurement|wide|long|length|tall|height)\b/.test(q),
  );
  if (measurement) {
    return {
      fact: measurement,
      reply: `The seller-confirmed ${measurement.key} measurement is ${measurement.value}.`,
    };
  }

  const included = q.match(/^(does|do) (it|this|the item) (include|come with|have) (.+)$/);
  if (included) {
    const premise = normalized(included[4]);
    const premiseTokens = premise
      .split(" ")
      .filter((token) => token.length > 2 && !["the", "any", "original"].includes(token));
    const fact = input.grounding.facts.find((candidate) => {
      if (
        !["active_listing_specific", "seller_confirmed_measurement"].includes(
          candidate.source,
        )
      ) {
        return false;
      }
      const corpusTokens = new Set(
        normalized(`${candidate.key} ${candidate.value}`).split(" "),
      );
      return (
        premiseTokens.length > 0 &&
        premiseTokens.every((token) => corpusTokens.has(token))
      );
    });
    return fact
      ? {
          fact,
          reply: `The seller-approved listing says: ${fact.key}: ${fact.value}.`,
        }
      : null;
  }

  return null;
}

function exactApprovedPolicyAnswer(
  input: DecideMessagePolicyInput,
): { fact: AuthoritativeFact; reply: string } | null {
  const q = normalized(input.question);
  const policyKey = q.match(
    /^(what is|whats) (your|the) (shipping|return|returns|warranty) policy$/,
  )?.[3];
  if (!policyKey) return null;
  const wanted = policyKey === "returns" ? "return" : policyKey;
  const fact = input.grounding.facts.find(
    (candidate) =>
      candidate.source === "seller_approved_policy" &&
      normalized(candidate.key).includes(wanted),
  );
  return fact
    ? {
        fact,
        reply: `The seller-approved ${fact.key.toLowerCase()} is: ${fact.value}.`,
      }
    : null;
}

/**
 * Deterministic final authorization. Buyer text is data, never instructions;
 * automatic replies are exact renderings of one current authoritative fact.
 */
export function decideMessagePolicy(
  rawInput: DecideMessagePolicyInput,
): MessagePolicyResult {
  const input = {
    ...rawInput,
    question: rawInput.question.trim(),
    grounding: authoritativeMessageGroundingSchema.parse(rawInput.grounding),
  };

  if (!input.enabled) {
    return result(input, "draft_for_approval", "preference_disabled");
  }
  if (INJECTION_RE.test(input.question)) {
    return result(input, "escalate", "untrusted_instruction");
  }
  if (POST_SALE_RE.test(input.question)) {
    return result(input, "escalate", "post_sale_out_of_scope");
  }
  const commitmentQuestion = COMMITMENT_RE.test(input.question);
  if (!commitmentQuestion && NEGOTIATION_RE.test(input.question)) {
    return result(input, "draft_for_approval", "negotiation_requires_seller");
  }
  if (!input.grounding.active) {
    return result(input, "escalate", "listing_not_authoritatively_active");
  }
  if (!input.grounding.current) {
    return result(input, "escalate", "authoritative_facts_stale");
  }
  if (input.grounding.conflicts.length > 0) {
    return result(input, "escalate", "authoritative_facts_conflict");
  }

  if (commitmentQuestion) {
    const policy = exactApprovedPolicyAnswer(input);
    return policy
      ? result(
          input,
          "auto_send",
          "exact_authoritative_fact",
          policy.fact,
          policy.reply,
        )
      : result(input, "draft_for_approval", "seller_commitment_required");
  }

  const exact = exactFactAnswer(input);
  if (!exact) {
    return result(input, "escalate", "authoritative_fact_missing");
  }
  return result(
    input,
    "auto_send",
    "exact_authoritative_fact",
    exact.fact,
    exact.reply,
  );
}
