import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REPLY_MODEL,
  draftBuyerReply,
  fallbackBuyerReply,
  groundingCorpus,
  replyAssertsUngroundedNumbers,
  type ReplyGenerate,
} from "./reply";
import type { ReplyGrounding } from "./types";

/**
 * Offline tests for the buyer-Q&A reply agent (issue #13 acceptance: "offline
 * tests with injected fake LLM proving grounding inputs are used and nothing is
 * hallucinated outside them"). NO network, NO Realtime: the model call is always
 * an injected fake.
 */

const grounding: ReplyGrounding = {
  attributes: {
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "good",
    specs: ["wireless", "noise-cancelling", "30 hour battery"],
    title: "Sony WH-1000XM4 Wireless Headphones",
  },
  listing: {
    title: "Sony WH-1000XM4 Wireless Noise Cancelling Headphones — Good",
    description:
      "Lightly used WH-1000XM4 in good condition. Priced at $180. Ships from a smoke-free home.",
  },
};

const question = "Does the battery still hold a charge well?";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("groundingCorpus", () => {
  it("contains EXACTLY the allowed grounding inputs: attributes and listing copy — NOT the question", () => {
    const corpus = groundingCorpus(grounding);
    // Attribute facts (string + array values).
    expect(corpus).toContain("sony");
    expect(corpus).toContain("wh-1000xm4");
    expect(corpus).toContain("30 hour battery");
    // Listing copy (carries the stored price).
    expect(corpus).toContain("priced at $180");
    // The buyer's question is NOT part of the grounding.
    expect(corpus).not.toContain("hold a charge");
  });

  it("works without a listing (attributes-only grounding)", () => {
    const corpus = groundingCorpus({ attributes: { brand: "Acme" }, listing: null });
    expect(corpus).toContain("acme");
  });
});

describe("buyer-Q&A grounds on stored measurements (issue #104)", () => {
  const measuredGrounding: ReplyGrounding = {
    attributes: {
      brand: "Champion",
      category: "clothing hoodie",
      condition: "good",
      title: "Champion Hoodie",
      measurements: [
        // Seller-CONFIRMED — the reply agent may state it.
        {
          name: "pit_to_pit",
          value_in: 21,
          tolerance_in: 0,
          method: "reference-scaled",
          confirmed: true,
        },
        // Unconfirmed AI draft — must NOT ground a reply to a buyer.
        {
          name: "length",
          value_in: 27,
          tolerance_in: 2,
          method: "prior-based",
          confirmed: false,
        },
      ],
    },
    listing: null,
  };

  it("puts confirmed measurements (only) in the grounding corpus", () => {
    const corpus = groundingCorpus(measuredGrounding);
    expect(corpus).toContain("pit to pit 21");
    expect(corpus).not.toContain("27"); // the unconfirmed length is excluded
  });

  it("accepts a reply stating a confirmed measurement, rejects an unconfirmed/invented one", () => {
    expect(
      replyAssertsUngroundedNumbers("The pit to pit measures 21 inches.", measuredGrounding),
    ).toBe(false);
    // 27 (unconfirmed) and 40 (invented) are both ungrounded assertions.
    expect(
      replyAssertsUngroundedNumbers("The length is 27 inches.", measuredGrounding),
    ).toBe(true);
    expect(
      replyAssertsUngroundedNumbers("The chest is 40 inches across.", measuredGrounding),
    ).toBe(true);
  });

  it("rejects a confirmed number re-attributed to a DIFFERENT measurement", () => {
    // pit_to_pit=21 is confirmed; sleeve is not. The shared unit word "inches" must
    // not let 21 bind to a sleeve claim, or a mis-attributed measurement ships.
    expect(
      replyAssertsUngroundedNumbers("The sleeve is 21 inches.", measuredGrounding),
    ).toBe(true);
    // The genuinely-confirmed measurement still passes when named correctly.
    expect(
      replyAssertsUngroundedNumbers("The pit to pit is 21 inches.", measuredGrounding),
    ).toBe(false);
  });

  it("draftBuyerReply answers a measurement question from the stored value", async () => {
    const generate: ReplyGenerate = async () => ({
      reply: "The pit to pit is 21 inches, measured flat.",
      answerable: true,
    });
    const out = await draftBuyerReply({
      question: "What's the pit to pit?",
      grounding: measuredGrounding,
      generate,
    });
    expect(out.usedFallback).toBe(false);
    expect(out.reply).toContain("21");
  });

  it("falls back rather than let the model invent a measurement", async () => {
    const generate: ReplyGenerate = async () => ({
      reply: "The chest is 40 inches across.", // 40 is nowhere in the grounding
      answerable: true,
    });
    const out = await draftBuyerReply({
      question: "How wide is the chest?",
      grounding: measuredGrounding,
      generate,
    });
    expect(out.usedFallback).toBe(true);
    expect(out.reply).not.toContain("40");
  });
});

describe("replyAssertsUngroundedNumbers", () => {
  it("accepts replies whose numbers all trace to the grounding", () => {
    const reply =
      "Yes — the WH-1000XM4 still gets the rated 30 hour battery life, and it's $180 as listed.";
    expect(replyAssertsUngroundedNumbers(reply, grounding)).toBe(false);
  });

  it("rejects a reply that invents a number found nowhere in the grounding", () => {
    const reply = "It retails for $349 new, so $180 is a great deal.";
    expect(replyAssertsUngroundedNumbers(reply, grounding)).toBe(true);
  });

  it("rejects invented shipping timings", () => {
    const reply = "I can ship within 2 days of purchase.";
    expect(replyAssertsUngroundedNumbers(reply, grounding)).toBe(true);
  });

  it("rejects asserting a number that only the buyer's question introduced (unverified premise)", () => {
    // "Can you ship in 2 days?" → "Yes, I can ship in 2 days" must NOT pass: the
    // 2 came from the buyer, not from any grounded fact.
    const reply = "Yes, I can ship in 2 days.";
    expect(replyAssertsUngroundedNumbers(reply, grounding)).toBe(true);
  });

  it("does NOT let digits mined out of an identifier license standalone numbers", () => {
    // The corpus contains WH-1000XM4 — its 4 (and 1000) are bound to that
    // token's factual context, not free-floating grounded numbers.
    const identifierOnly: ReplyGrounding = {
      attributes: { model: "WH-1000XM4" },
      listing: null,
    };
    expect(
      replyAssertsUngroundedNumbers("I can ship in 4 days.", identifierOnly),
    ).toBe(true);
    expect(
      replyAssertsUngroundedNumbers("They cost 1000 new.", identifierOnly),
    ).toBe(true);
    // The identifier itself, as a whole token, IS grounded (case-insensitive).
    expect(
      replyAssertsUngroundedNumbers("Yes, this is the WH-1000XM4.", identifierOnly),
    ).toBe(false);
  });

  it("rejects a digit-bearing token that is only a FRAGMENT of a corpus token", () => {
    // "1000xm4" appears inside "wh-1000xm4" but never as a whole token.
    expect(replyAssertsUngroundedNumbers("It's the 1000XM4.", grounding)).toBe(true);
  });

  it("grounds a standalone number only when the corpus carries it as a standalone number", () => {
    const priced: ReplyGrounding = {
      attributes: { model: "WH-1000XM4" },
      listing: { title: "Sony headphones", description: "Asking $45, firm." },
    };
    // 45 appears standalone in the listing copy → an asserted 45 is grounded.
    expect(replyAssertsUngroundedNumbers("I'm asking $45 for them.", priced)).toBe(false);
    // …but it does not license other numbers.
    expect(replyAssertsUngroundedNumbers("I'm asking $40 for them.", priced)).toBe(true);
  });

  it("never lets context windows cross sentence boundaries — a price cannot launder into a shipping claim", () => {
    // "Priced at $180. Ships from a smoke-free home." — `180`'s claim context
    // is its OWN sentence; the adjacent sentence's "ships" must not vouch for
    // "It ships in 180."
    expect(replyAssertsUngroundedNumbers("It ships in 180.", grounding)).toBe(true);

    const twoSentence: ReplyGrounding = {
      attributes: { title: "Game console" },
      listing: {
        title: "Console",
        description: "Battery lasts 30 hours. Ships in 2 boxes.",
      },
    };
    // Cross-sentence laundering rejected; same-sentence claims still pass.
    expect(
      replyAssertsUngroundedNumbers("Ships in 30 days.", twoSentence),
    ).toBe(true);
    expect(
      replyAssertsUngroundedNumbers("The battery lasts 30 hours.", twoSentence),
    ).toBe(false);
    expect(replyAssertsUngroundedNumbers("Ships in 2 boxes.", twoSentence)).toBe(
      false,
    );
  });

  it("binds a grounded number to its claim context — a count cannot be repurposed as a timing", () => {
    const bundle: ReplyGrounding = {
      attributes: { title: "PS5 console bundle" },
      listing: {
        title: "PS5 bundle",
        description: "Includes 2 controllers and the original box.",
      },
    };
    // Same claim ("2 controllers") → grounded.
    expect(
      replyAssertsUngroundedNumbers("Yes, it comes with 2 controllers.", bundle),
    ).toBe(false);
    // The SAME digit repurposed for an unrelated assertion → rejected: the
    // grounding says nothing about shipping time.
    expect(
      replyAssertsUngroundedNumbers("Yes, I can ship in 2 days.", bundle),
    ).toBe(true);
  });
});

describe("draftBuyerReply", () => {
  it("passes the question and the FULL grounding to the injected model call", async () => {
    vi.stubEnv("LLM_PROVIDER", "openai");
    const calls: Parameters<ReplyGenerate>[0][] = [];
    const generate: ReplyGenerate = async (args) => {
      calls.push(args);
      return { reply: "Yes, the battery is still strong.", answerable: true };
    };

    const result = await draftBuyerReply({ question, grounding, generate });

    expect(calls).toHaveLength(1);
    // The grounding inputs ARE what the agent reasons over — attributes + listing.
    expect(calls[0].question).toBe(question);
    expect(calls[0].grounding).toEqual(grounding);
    expect(calls[0].model).toBe(DEFAULT_REPLY_MODEL);
    expect(result).toEqual({
      reply: "Yes, the battery is still strong.",
      model: DEFAULT_REPLY_MODEL,
      usedFallback: false,
    });
  });

  it("retries when the model asserts an ungrounded number, then accepts a clean retry", async () => {
    const replies = [
      { reply: "It retails for $349 new!", answerable: true }, // invented number
      { reply: "It's in good condition and priced at $180 as listed.", answerable: true },
    ];
    let attempt = 0;
    const generate: ReplyGenerate = async (args) => {
      expect(args.attempt).toBe(attempt);
      return replies[attempt++];
    };

    const result = await draftBuyerReply({ question, grounding, generate });
    expect(attempt).toBe(2);
    expect(result.usedFallback).toBe(false);
    expect(result.reply).toContain("$180");
  });

  it("falls back to the deterministic grounded reply when every attempt hallucinates", async () => {
    const generate: ReplyGenerate = async () => ({
      reply: "Ships in 2 days, retails for $349.",
      answerable: true,
    });

    const result = await draftBuyerReply({ question, grounding, generate, maxRetries: 1 });
    expect(result.usedFallback).toBe(true);
    expect(result.reply).toBe(fallbackBuyerReply(grounding));
    // The fallback itself only states grounded facts.
    expect(replyAssertsUngroundedNumbers(result.reply, grounding)).toBe(false);
    expect(result.reply).toContain("Sony WH-1000XM4");
    expect(result.reply).toContain("good condition");
  });

  it("forces retry → grounded fallback when the model asserts a number taken from the buyer's question", async () => {
    // The classic unverified-premise laundering: the buyer supplies "2 days", the
    // model agrees. Question-derived numbers are NOT grounded, so every attempt
    // fails the guard and the deterministic fallback answers instead.
    const q = "Can you ship in 2 days?";
    let calls = 0;
    const generate: ReplyGenerate = async () => {
      calls++;
      return { reply: "Yes, I can ship in 2 days.", answerable: true };
    };

    const result = await draftBuyerReply({ question: q, grounding, generate, maxRetries: 1 });
    expect(calls).toBe(2); // initial attempt + one retry, both rejected
    expect(result.usedFallback).toBe(true);
    expect(result.reply).toBe(fallbackBuyerReply(grounding));
  });

  it("forces retry → grounded fallback when the model launders a standalone number out of an identifier", async () => {
    // The corpus has WH-1000XM4 (so "4" exists inside an identifier) but no
    // standalone 4: "ship in 4 days" is a contextual-grounding violation on
    // every attempt → deterministic fallback.
    let calls = 0;
    const generate: ReplyGenerate = async () => {
      calls++;
      return { reply: "I can ship in 4 days.", answerable: true };
    };

    const result = await draftBuyerReply({
      question: "How fast can you ship?",
      grounding,
      generate,
      maxRetries: 1,
    });
    expect(calls).toBe(2); // initial attempt + one retry, both rejected
    expect(result.usedFallback).toBe(true);
    expect(result.reply).toBe(fallbackBuyerReply(grounding));
  });

  it("uses the fallback (without retrying) when the model says the question is unanswerable from the grounding", async () => {
    let calls = 0;
    const generate: ReplyGenerate = async () => {
      calls++;
      return { reply: "The battery was replaced last year.", answerable: false };
    };

    const result = await draftBuyerReply({ question, grounding, generate, maxRetries: 3 });
    expect(calls).toBe(1);
    expect(result.usedFallback).toBe(true);
    expect(result.reply).toBe(fallbackBuyerReply(grounding));
  });

  it("never throws when the model call fails — the fallback always answers", async () => {
    const generate: ReplyGenerate = async () => {
      throw new Error("model unavailable");
    };

    const result = await draftBuyerReply({ question, grounding, generate });
    expect(result.usedFallback).toBe(true);
    expect(result.reply).toBe(fallbackBuyerReply(grounding));
  });

  it("retries on an empty reply", async () => {
    const replies = [
      { reply: "   ", answerable: true },
      { reply: "Battery health is good.", answerable: true },
    ];
    let i = 0;
    const generate: ReplyGenerate = async () => replies[i++];

    const result = await draftBuyerReply({ question, grounding, generate });
    expect(result.reply).toBe("Battery health is good.");
    expect(result.usedFallback).toBe(false);
  });

  it("resolves the model id: explicit > REPLY_MODEL env > default", async () => {
    const seen: string[] = [];
    const generate: ReplyGenerate = async ({ model }) => {
      seen.push(model);
      return { reply: "ok", answerable: true };
    };

    await draftBuyerReply({ question, grounding, generate, model: "explicit-model" });
    vi.stubEnv("REPLY_MODEL", "env-model");
    await draftBuyerReply({ question, grounding, generate });
    vi.unstubAllEnvs();
    // No override and no role env → the active provider's default. Pin the
    // provider to OpenAI so the bare default is DEFAULT_REPLY_MODEL (the test
    // env otherwise defaults to the Gemini provider).
    vi.stubEnv("LLM_PROVIDER", "openai");
    await draftBuyerReply({ question, grounding, generate });

    expect(seen).toEqual(["explicit-model", "env-model", DEFAULT_REPLY_MODEL]);
  });
});

describe("fallbackBuyerReply", () => {
  it("omits the condition line when the grounding has no condition", () => {
    const reply = fallbackBuyerReply({ attributes: { brand: "Acme" }, listing: null });
    expect(reply).toContain("Acme");
    expect(reply).not.toContain("condition");
  });

  it("never claims a listing exists when the grounding has none", () => {
    // Items can be in the inbox before any listing exists; "as described in
    // the listing" would itself be a hallucinated fact then.
    const noListing = fallbackBuyerReply({
      attributes: { brand: "Acme", condition: "good" },
      listing: null,
    });
    expect(noListing).toContain("good condition");
    expect(noListing).not.toContain("listing");

    const withListing = fallbackBuyerReply({
      attributes: { brand: "Acme", condition: "good" },
      listing: { title: "Acme widget", description: "A widget." },
    });
    expect(withListing).toContain("as described in the listing");
  });
});
