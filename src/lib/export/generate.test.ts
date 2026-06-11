import { describe, expect, it } from "vitest";
import { listingCopySchema, type ExtractedAttributes } from "../pipeline/types";
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
  type RawExportPacks,
} from "./schema";
import {
  FACEBOOK_PICKUP_LINE,
  MERCARI_SHIPPING_SUFFIX,
  buildNumericGrounding,
  derivableHashtagBodies,
  deriveDefaultHashtags,
  descriptionsViolateGrounding,
  fallbackDescription,
  fallbackFacebookDescription,
  fallbackFacebookTitle,
  fallbackMercariDescription,
  fallbackMercariTitle,
  findUngroundedNumbers,
  formatPrice,
  generateExportPacks,
  normalizeHashtag,
  packsHallucinateAttributes,
  reconcileHashtags,
  repairMercariDescription,
  titlesViolateGrounding,
  type ExportPackGenerate,
} from "./generate";

/**
 * Export-pack CONTRACT tests (issue #15). Fully OFFLINE: the model call is
 * injected, so no network / key is touched. We assert the BOUNDARY behavior
 * (AGENTS.md: test platform constraints, not model quality):
 *
 *  - both packs validate against their strict platform schemas and map onto
 *    the `ListingCopy` seam;
 *  - FB conventions hold structurally: title ≤ 99, short description, and the
 *    local-pickup line is ALWAYS the block's closer;
 *  - Mercari conventions hold structurally: title ≤ 40, ≤ 3 normalized
 *    hashtags, and the description ALWAYS mentions shipping;
 *  - NO attribute is invented beyond the validated core: every emitted hashtag
 *    is derivable from the core (whitelist), and the price line comes ONLY from
 *    the caller-passed stored price — never from the model;
 *  - each platform's output is ONE clean copy-paste string.
 */

/** A strong, fully-resolved attribute core (same hero item as the eBay tests). */
const CORE: ExtractedAttributes = {
  brand: "Sony",
  model: "WH-1000XM4",
  category: "electronics",
  condition: "good",
  specs: ["wireless", "noise-cancelling", "over-ear"],
  title: "Sony WH-1000XM4 Wireless Noise-Cancelling Headphones",
};

/** Clean, in-spec raw packs a well-behaved model would emit for CORE. */
const GOOD_RAW: RawExportPacks = {
  facebook: {
    title: "Sony WH-1000XM4 wireless headphones",
    description:
      "Selling my Sony WH-1000XM4 noise-cancelling headphones, good condition. " +
      "They work great — just don't use them anymore.",
  },
  mercari: {
    title: "Sony WH-1000XM4 Headphones",
    description:
      "Sony WH-1000XM4 wireless noise-cancelling headphones in good condition. " +
      "Ships out within a day of purchase, packed carefully.",
    hashtags: ["#sony", "#headphones", "#wh1000xm4"],
  },
};

/** A queue-backed fake `generate`: returns the next scripted raw packs per call. */
function scriptedGenerate(results: RawExportPacks[]): {
  generate: ExportPackGenerate;
  calls: Array<Parameters<ExportPackGenerate>[0]>;
} {
  const calls: Array<Parameters<ExportPackGenerate>[0]> = [];
  let i = 0;
  const generate: ExportPackGenerate = async (args) => {
    calls.push(args);
    const r = results[Math.min(i, results.length - 1)]!;
    i += 1;
    return r;
  };
  return { generate, calls };
}

describe("generateExportPacks — happy path", () => {
  it("returns schema-valid packs for both platforms, mapped onto ListingCopy", async () => {
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({
      attributes: CORE,
      generate,
      model: "test-model",
    });

    expect(facebookPackSchema.safeParse(res.facebook.pack).success).toBe(true);
    expect(mercariPackSchema.safeParse(res.mercari.pack).success).toBe(true);

    const fbCopy = listingCopySchema.parse(res.facebook.copy);
    expect(fbCopy.platform).toBe(FACEBOOK_PLATFORM);
    expect(fbCopy.title).toBe(res.facebook.pack.title);
    expect(fbCopy.fields["copyBlock"]).toBe(res.facebook.copyBlock);

    const mCopy = listingCopySchema.parse(res.mercari.copy);
    expect(mCopy.platform).toBe(MERCARI_PLATFORM);
    expect(mCopy.fields["hashtags"]).toEqual(res.mercari.pack.hashtags);
    expect(mCopy.fields["copyBlock"]).toBe(res.mercari.copyBlock);

    expect(res.model).toBe("test-model");
  });

  it("each copy block is ONE clean paste-able string containing title + description", async () => {
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({ attributes: CORE, generate });

    for (const platform of [res.facebook, res.mercari]) {
      expect(typeof platform.copyBlock).toBe("string");
      expect(platform.copyBlock).toContain(platform.pack.title);
      expect(platform.copyBlock).toContain(platform.pack.description);
    }
  });
});

describe("Facebook conventions (structural)", () => {
  it("always closes the block with the local-pickup line", async () => {
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    const lines = res.facebook.copyBlock.split("\n");
    expect(lines[lines.length - 1]).toBe(FACEBOOK_PICKUP_LINE);
  });

  it("repairs an over-long FB title deterministically to ≤ 99 chars", async () => {
    const longTitle = "Sony WH-1000XM4 wireless noise cancelling headphones ".repeat(5);
    const { generate } = scriptedGenerate([
      { ...GOOD_RAW, facebook: { ...GOOD_RAW.facebook, title: longTitle } },
    ]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    expect(res.facebook.pack.title.length).toBeLessThanOrEqual(
      FACEBOOK_TITLE_MAX_LENGTH,
    );
    expect(res.facebook.pack.title.length).toBeGreaterThan(0);
  });

  it("keeps the FB description structurally short (≤ cap) even when the model rambles", async () => {
    const ramble = "These headphones are truly wonderful in every way. ".repeat(40);
    const { generate } = scriptedGenerate([
      { ...GOOD_RAW, facebook: { ...GOOD_RAW.facebook, description: ramble } },
    ]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    expect(res.facebook.pack.description.length).toBeLessThanOrEqual(
      FACEBOOK_DESCRIPTION_MAX_LENGTH,
    );
  });

  it("includes the core condition as a deterministic meta line only when present", async () => {
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const withCondition = await generateExportPacks({ attributes: CORE, generate });
    expect(withCondition.facebook.copyBlock).toContain("Condition: good");

    const { generate: g2 } = scriptedGenerate([GOOD_RAW]);
    const bare = await generateExportPacks({
      attributes: { category: "electronics" },
      generate: g2,
    });
    expect(bare.facebook.copyBlock).not.toContain("Condition:");
  });
});

describe("Mercari conventions (structural)", () => {
  it("repairs an over-long Mercari title deterministically to ≤ 40 chars", async () => {
    const { generate } = scriptedGenerate([
      {
        ...GOOD_RAW,
        mercari: {
          ...GOOD_RAW.mercari,
          title: "Sony WH-1000XM4 Wireless Noise-Cancelling Over-Ear Headphones Black",
        },
      },
    ]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    expect(res.mercari.pack.title.length).toBeLessThanOrEqual(
      MERCARI_TITLE_MAX_LENGTH,
    );
    expect(res.mercari.pack.title.length).toBeGreaterThan(0);
  });

  it("guarantees a shipping mention: appends the neutral suffix when the model forgot", async () => {
    const { generate } = scriptedGenerate([
      {
        ...GOOD_RAW,
        mercari: {
          ...GOOD_RAW.mercari,
          description: "Sony WH-1000XM4 headphones in good condition.",
        },
      },
    ]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    expect(res.mercari.pack.description).toMatch(/ship/i);
    expect(res.mercari.pack.description).toContain(MERCARI_SHIPPING_SUFFIX);
  });

  it("keeps a model-written shipping mention untouched (no double suffix)", async () => {
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    expect(res.mercari.pack.description).toBe(GOOD_RAW.mercari.description);
  });

  it("caps the repaired description at the Mercari limit even for a rambling model", async () => {
    const ramble = "Great wireless sound and very comfortable to wear all day. ".repeat(40);
    const { generate } = scriptedGenerate([
      { ...GOOD_RAW, mercari: { ...GOOD_RAW.mercari, description: ramble } },
    ]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    expect(res.mercari.pack.description.length).toBeLessThanOrEqual(
      MERCARI_DESCRIPTION_MAX_LENGTH,
    );
    expect(res.mercari.pack.description).toMatch(/ship/i);
  });

  it("bounds hashtags at 3 and normalizes their format", async () => {
    const { generate } = scriptedGenerate([
      {
        ...GOOD_RAW,
        mercari: {
          ...GOOD_RAW.mercari,
          hashtags: [
            "#Sony",
            "Headphones",
            "#Noise-Cancelling",
            "#wireless",
            "#electronics",
            "#WH1000XM4",
          ],
        },
      },
    ]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    const tags = res.mercari.pack.hashtags;
    expect(tags.length).toBeLessThanOrEqual(MERCARI_MAX_HASHTAGS);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag).toMatch(/^#[a-z0-9]+$/);
  });

  it("renders hashtags as the block's final line", async () => {
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    const lines = res.mercari.copyBlock.split("\n");
    expect(lines[lines.length - 1]).toBe(res.mercari.pack.hashtags.join(" "));
  });
});

describe("no hallucinated attributes beyond the validated core", () => {
  it("drops hashtags that assert attributes the core never established", async () => {
    const { generate, calls } = scriptedGenerate([
      {
        ...GOOD_RAW,
        mercari: {
          ...GOOD_RAW.mercari,
          // "#bose" and "#bluetooth52" are NOT derivable from CORE.
          hashtags: ["#bose", "#bluetooth52", "#sony"],
        },
      },
    ]);
    const res = await generateExportPacks({ attributes: CORE, generate });

    const allowed = derivableHashtagBodies(CORE);
    for (const tag of res.mercari.pack.hashtags) {
      expect(allowed.has(tag.slice(1))).toBe(true);
    }
    expect(res.mercari.pack.hashtags).not.toContain("#bose");
    expect(res.mercari.pack.hashtags).not.toContain("#bluetooth52");
    // The hallucination triggered a self-correction retry before settling on
    // the deterministically-cleaned candidate.
    expect(calls.length).toBe(2);
  });

  it("a sparse core cannot gain a brand via hashtags; falls back to core-derived tags", async () => {
    const sparse: ExtractedAttributes = { category: "kitchen", condition: "fair" };
    const { generate } = scriptedGenerate([
      {
        facebook: { title: "Kitchen mixer", description: "Works fine, some wear." },
        mercari: {
          title: "Kitchen mixer",
          description: "Ships fast.",
          hashtags: ["#kitchenaid", "#mixer"], // brand + noun the core never established
        },
      },
    ]);
    const res = await generateExportPacks({ attributes: sparse, generate, maxRetries: 0 });
    expect(res.mercari.pack.hashtags).not.toContain("#kitchenaid");
    expect(res.mercari.pack.hashtags).not.toContain("#mixer");
    // Deterministic fallback derives only from the core (category here).
    expect(res.mercari.pack.hashtags).toEqual(["#kitchen"]);
  });

  it("every output fact line traces to inputs: condition from core, price from caller, pickup constant", async () => {
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({ attributes: CORE, generate, price: 120 });
    const metaLines = res.facebook.copyBlock.split("\n").slice(-3);
    expect(metaLines).toEqual([
      "Condition: good",
      "Asking $120",
      FACEBOOK_PICKUP_LINE,
    ]);
  });
});

describe("price grounding: stored price only, never generated", () => {
  it("renders the caller-passed stored price verbatim", async () => {
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({ attributes: CORE, generate, price: 49.99 });
    expect(res.facebook.copyBlock).toContain("Asking $49.99");
  });

  it("omits the price line entirely when the item carries no price", async () => {
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    expect(res.facebook.copyBlock).not.toContain("Asking");
    expect(res.facebook.copyBlock).not.toContain("$");
    expect(res.mercari.copyBlock).not.toContain("$");
  });

  it("formats whole and fractional prices predictably", () => {
    expect(formatPrice(45)).toBe("$45");
    expect(formatPrice(49.9)).toBe("$49.90");
  });
});

describe("retry + failure behavior", () => {
  it("retries past a throwing generate and succeeds on the next attempt", async () => {
    let first = true;
    const calls: number[] = [];
    const generate: ExportPackGenerate = async ({ attempt }) => {
      calls.push(attempt);
      if (first) {
        first = false;
        throw new Error("schema-invalid response");
      }
      return GOOD_RAW;
    };
    const res = await generateExportPacks({ attributes: CORE, generate, maxRetries: 1 });
    expect(calls).toEqual([0, 1]);
    expect(res.facebook.pack.title).toBe(GOOD_RAW.facebook.title);
  });

  it("throws after exhausting attempts with no usable candidate", async () => {
    const generate: ExportPackGenerate = async () => {
      throw new Error("model unavailable");
    };
    await expect(
      generateExportPacks({ attributes: CORE, generate, maxRetries: 1 }),
    ).rejects.toThrow(/failed after 2 attempt/);
  });

  it("returns the cleaned candidate when the model hallucinates on every attempt", async () => {
    const dirty: RawExportPacks = {
      ...GOOD_RAW,
      mercari: { ...GOOD_RAW.mercari, hashtags: ["#bose", "#sony"] },
    };
    const { generate, calls } = scriptedGenerate([dirty, dirty]);
    const res = await generateExportPacks({ attributes: CORE, generate, maxRetries: 1 });
    expect(calls.length).toBe(2);
    expect(res.mercari.pack.hashtags).toContain("#sony");
    expect(res.mercari.pack.hashtags).not.toContain("#bose");
  });
});

describe("description grounding: no ungrounded numbers or prices in free text", () => {
  /** Helper: every numeric token in `text` is contextually grounded in CORE. */
  function ungrounded(text: string): string[] {
    return findUngroundedNumbers(text, buildNumericGrounding(CORE));
  }

  it("a model-written '$50' in the FB description triggers retry, then the deterministic fallback", async () => {
    const dirty: RawExportPacks = {
      ...GOOD_RAW,
      facebook: {
        ...GOOD_RAW.facebook,
        description: "Great Sony headphones, asking $50 or best offer.",
      },
    };
    const { generate, calls } = scriptedGenerate([dirty, dirty]);
    const res = await generateExportPacks({ attributes: CORE, generate, maxRetries: 1 });

    // One self-correction retry happened before settling on the fallback.
    expect(calls.length).toBe(2);
    // The claim is NOT published: deterministic core-only fallback instead.
    expect(res.facebook.pack.description).toBe(fallbackFacebookDescription(CORE));
    expect(res.facebook.pack.description).not.toContain("$");
    expect(res.facebook.pack.description).not.toContain("50");
    expect(facebookPackSchema.safeParse(res.facebook.pack).success).toBe(true);
    // The Mercari description was clean and survives untouched.
    expect(res.mercari.pack.description).toBe(GOOD_RAW.mercari.description);
  });

  it("an unsupported number in the Mercari description triggers retry, then the deterministic fallback", async () => {
    const dirty: RawExportPacks = {
      ...GOOD_RAW,
      mercari: {
        ...GOOD_RAW.mercari,
        description:
          "Sony WH-1000XM4 headphones, includes a 25W charger. Ships fast.",
      },
    };
    const { generate, calls } = scriptedGenerate([dirty, dirty]);
    const res = await generateExportPacks({ attributes: CORE, generate, maxRetries: 1 });

    expect(calls.length).toBe(2);
    expect(res.mercari.pack.description).toBe(fallbackMercariDescription(CORE));
    expect(res.mercari.pack.description).not.toContain("25");
    // The fallback still honors the Mercari shipping convention and schema.
    expect(res.mercari.pack.description).toMatch(/ship/i);
    expect(mercariPackSchema.safeParse(res.mercari.pack).success).toBe(true);
    // The FB description was clean and survives untouched.
    expect(res.facebook.pack.description).toBe(GOOD_RAW.facebook.description);
  });

  it("a successful self-correction retry publishes the model's clean copy, not the fallback", async () => {
    const dirty: RawExportPacks = {
      ...GOOD_RAW,
      facebook: { ...GOOD_RAW.facebook, description: "Asking 50 dollars, like new." },
    };
    const { generate, calls } = scriptedGenerate([dirty, GOOD_RAW]);
    const res = await generateExportPacks({ attributes: CORE, generate, maxRetries: 1 });
    expect(calls.length).toBe(2);
    expect(res.facebook.pack.description).toBe(GOOD_RAW.facebook.description);
  });

  it("grounded numbers from the core pass without a retry (e.g. 'WH-1000XM4', '128GB')", async () => {
    const core: ExtractedAttributes = { ...CORE, specs: [...CORE.specs!, "128GB case"] };
    const raw: RawExportPacks = {
      ...GOOD_RAW,
      facebook: {
        ...GOOD_RAW.facebook,
        description:
          "Sony WH-1000XM4 headphones with the 128GB case, good condition.",
      },
    };
    const { generate, calls } = scriptedGenerate([raw]);
    const res = await generateExportPacks({ attributes: core, generate });
    expect(calls.length).toBe(1);
    expect(res.facebook.pack.description).toBe(raw.facebook.description);
  });

  it("the deterministic fallback satisfies both strict schemas and contains no ungrounded numbers", () => {
    const fb = fallbackFacebookDescription(CORE);
    const mercari = fallbackMercariDescription(CORE);
    expect(
      facebookPackSchema.safeParse({ title: "t", description: fb }).success,
    ).toBe(true);
    expect(
      mercariPackSchema.safeParse({ title: "t", description: mercari, hashtags: [] })
        .success,
    ).toBe(true);
    expect(ungrounded(fb)).toEqual([]);
    expect(ungrounded(mercari)).toEqual([]);
    // A bare core still yields non-empty, schema-valid fallback text.
    expect(fallbackDescription({}).length).toBeGreaterThan(0);
    expect(ungrounded(fallbackFacebookDescription({}))).toEqual([]);
  });

  it("grounds numbers by CONTEXT: digits mined out of identifiers never license standalone numbers", async () => {
    // CORE's model is WH-1000XM4, so the bare digit "4" exists in the core —
    // but "Includes 4 charging cables" is a different CLAIM and must violate.
    const dirty: RawExportPacks = {
      ...GOOD_RAW,
      facebook: {
        ...GOOD_RAW.facebook,
        description: "Sony WH-1000XM4 headphones. Includes 4 charging cables.",
      },
    };
    const { generate, calls } = scriptedGenerate([dirty, dirty]);
    const res = await generateExportPacks({ attributes: CORE, generate, maxRetries: 1 });

    // Retry happened, then the deterministic core-only fallback was published.
    expect(calls.length).toBe(2);
    expect(res.facebook.pack.description).toBe(fallbackFacebookDescription(CORE));
    expect(res.facebook.pack.description).not.toContain("4 charging");
  });

  it("the stored price never grounds free text: '50-hour battery' violates even at price 50", () => {
    const grounding = buildNumericGrounding(CORE);
    // The price is deliberately ABSENT from the grounding context, so a stored
    // price of 50 cannot license "50-hour battery" (or any other 50-claim).
    expect(findUngroundedNumbers("50-hour battery life.", grounding)).toEqual([
      "50-hour",
    ]);
    expect(
      descriptionsViolateGrounding(
        {
          ...GOOD_RAW,
          facebook: {
            ...GOOD_RAW.facebook,
            description: "Amazing 50-hour battery life on these.",
          },
        },
        CORE,
      ),
    ).toBe(true);
  });

  it("buildNumericGrounding carries core values and standalone numbers, never the price", () => {
    const grounding = buildNumericGrounding({
      ...CORE,
      specs: [...CORE.specs!, "2 ear pads included"],
    });
    expect(grounding.coreValues).toContain("wh-1000xm4");
    // "2" appears standalone in a spec; "1000"/"4" only inside the identifier.
    expect(grounding.standaloneNumbers.has("2")).toBe(true);
    expect(grounding.standaloneNumbers.has("1000")).toBe(false);
    expect(grounding.standaloneNumbers.has("4")).toBe(false);
  });

  it("findUngroundedNumbers flags currency-like spans regardless of context", () => {
    // Writing any number AS A PRICE is always a violation — the price line is
    // appended deterministically, never written by the model.
    expect(ungrounded("Asking $120 firm.").length).toBeGreaterThan(0);
    expect(ungrounded("Asking 120 dollars.").length).toBeGreaterThan(0);
    // An identifier fragment that appears whole inside a core value passes.
    expect(ungrounded("The 1000XM4 model.")).toEqual([]);
    // A standalone number matching a standalone core number passes.
    const withCount = buildNumericGrounding({ ...CORE, specs: ["2 cables"] });
    expect(findUngroundedNumbers("Comes with 2 cables.", withCount)).toEqual([]);
  });

  it("packsHallucinateAttributes now covers descriptions, not just hashtags", () => {
    expect(packsHallucinateAttributes(GOOD_RAW, CORE)).toBe(false);
    expect(
      packsHallucinateAttributes(
        {
          ...GOOD_RAW,
          facebook: { ...GOOD_RAW.facebook, description: "Asking $50." },
        },
        CORE,
      ),
    ).toBe(true);
    expect(
      packsHallucinateAttributes(
        {
          ...GOOD_RAW,
          mercari: { ...GOOD_RAW.mercari, description: "Includes 3 cables. Ships." },
        },
        CORE,
      ),
    ).toBe(true);
    expect(descriptionsViolateGrounding(GOOD_RAW, CORE)).toBe(false);
  });
});

describe("title grounding: titles are validated against the attribute core", () => {
  it("a mutated model number in a title triggers retry, then the deterministic fallback title", async () => {
    const dirty: RawExportPacks = {
      ...GOOD_RAW,
      facebook: {
        ...GOOD_RAW.facebook,
        // "WH-1000XM5" is NOT the core's model (WH-1000XM4) — must not publish.
        title: "Sony WH-1000XM5 wireless headphones",
      },
    };
    const { generate, calls } = scriptedGenerate([dirty, dirty]);
    const res = await generateExportPacks({ attributes: CORE, generate, maxRetries: 1 });

    // One self-correction retry happened before settling on the fallback.
    expect(calls.length).toBe(2);
    expect(res.facebook.pack.title).toBe(fallbackFacebookTitle(CORE));
    expect(res.facebook.pack.title).not.toContain("XM5");
    expect(facebookPackSchema.safeParse(res.facebook.pack).success).toBe(true);
    // The clean Mercari title survives untouched.
    expect(res.mercari.pack.title).toBe(GOOD_RAW.mercari.title);
  });

  it("an ungrounded Mercari title is replaced with the Mercari-capped fallback", async () => {
    const dirty: RawExportPacks = {
      ...GOOD_RAW,
      mercari: { ...GOOD_RAW.mercari, title: "Sony WH-1000XM5 Headphones" },
    };
    const { generate, calls } = scriptedGenerate([dirty, dirty]);
    const res = await generateExportPacks({ attributes: CORE, generate, maxRetries: 1 });

    expect(calls.length).toBe(2);
    expect(res.mercari.pack.title).toBe(fallbackMercariTitle(CORE));
    expect(res.mercari.pack.title.length).toBeLessThanOrEqual(MERCARI_TITLE_MAX_LENGTH);
    expect(mercariPackSchema.safeParse(res.mercari.pack).success).toBe(true);
  });

  it("a successful title self-correction publishes the model's clean title, not the fallback", async () => {
    const dirty: RawExportPacks = {
      ...GOOD_RAW,
      facebook: { ...GOOD_RAW.facebook, title: "Sony WH-1000XM5 headphones" },
    };
    const { generate, calls } = scriptedGenerate([dirty, GOOD_RAW]);
    const res = await generateExportPacks({ attributes: CORE, generate, maxRetries: 1 });
    expect(calls.length).toBe(2);
    expect(res.facebook.pack.title).toBe(GOOD_RAW.facebook.title);
  });

  it("clean grounded titles pass without a retry", async () => {
    const { generate, calls } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    expect(calls.length).toBe(1);
    expect(res.facebook.pack.title).toBe(GOOD_RAW.facebook.title);
    expect(res.mercari.pack.title).toBe(GOOD_RAW.mercari.title);
  });

  it("titlesViolateGrounding flags only ungrounded titles; the fallbacks are grounded and capped", () => {
    expect(titlesViolateGrounding(GOOD_RAW, CORE)).toBe(false);
    expect(
      titlesViolateGrounding(
        {
          ...GOOD_RAW,
          facebook: { ...GOOD_RAW.facebook, title: "Sony WH-1000XM5" },
        },
        CORE,
      ),
    ).toBe(true);
    const grounding = buildNumericGrounding(CORE);
    expect(findUngroundedNumbers(fallbackFacebookTitle(CORE), grounding)).toEqual([]);
    expect(findUngroundedNumbers(fallbackMercariTitle(CORE), grounding)).toEqual([]);
    expect(fallbackMercariTitle(CORE).length).toBeLessThanOrEqual(
      MERCARI_TITLE_MAX_LENGTH,
    );
    // A bare core still yields a non-empty fallback title.
    expect(fallbackFacebookTitle({}).length).toBeGreaterThan(0);
  });
});

describe("hashtag helpers (unit)", () => {
  it("normalizeHashtag lowercases, strips punctuation, and prefixes #", () => {
    expect(normalizeHashtag("Noise-Cancelling")).toBe("#noisecancelling");
    expect(normalizeHashtag("##SONY")).toBe("#sony");
    expect(normalizeHashtag("#!!")).toBeNull();
  });

  it("derivableHashtagBodies covers whole strings, words, and the brand+model compound", () => {
    const bodies = derivableHashtagBodies(CORE);
    expect(bodies.has("sony")).toBe(true);
    expect(bodies.has("wh1000xm4")).toBe(true);
    expect(bodies.has("sonywh1000xm4")).toBe(true);
    expect(bodies.has("noisecancelling")).toBe(true);
    expect(bodies.has("cancelling")).toBe(true);
    expect(bodies.has("bose")).toBe(false);
  });

  it("reconcileHashtags dedupes and falls back to core defaults when nothing survives", () => {
    expect(reconcileHashtags(["#sony", "#Sony", "#sony"], CORE)).toEqual(["#sony"]);
    expect(reconcileHashtags(["#bose"], CORE)).toEqual(deriveDefaultHashtags(CORE));
  });

  it("deriveDefaultHashtags is empty for an empty core (schema allows zero tags)", () => {
    expect(deriveDefaultHashtags({})).toEqual([]);
    const parsed = mercariPackSchema.safeParse({
      title: "t",
      description: "Ships fast.",
      hashtags: [],
    });
    expect(parsed.success).toBe(true);
  });

  it("packsHallucinateAttributes flags only non-derivable tags", () => {
    expect(
      packsHallucinateAttributes(
        { ...GOOD_RAW, mercari: { ...GOOD_RAW.mercari, hashtags: ["#sony"] } },
        CORE,
      ),
    ).toBe(false);
    expect(
      packsHallucinateAttributes(
        { ...GOOD_RAW, mercari: { ...GOOD_RAW.mercari, hashtags: ["#bose"] } },
        CORE,
      ),
    ).toBe(true);
  });

  it("repairMercariDescription always yields a ≤-cap, shipping-mentioning string", () => {
    const long = "x".repeat(2000);
    const repaired = repairMercariDescription(long);
    expect(repaired.length).toBeLessThanOrEqual(MERCARI_DESCRIPTION_MAX_LENGTH);
    expect(repaired).toMatch(/ship/i);
    expect(repairMercariDescription("Already ships with tracking.")).toBe(
      "Already ships with tracking.",
    );
  });
});
