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
  DEPOP_DESCRIPTION_MAX_LENGTH,
  DEPOP_MAX_HASHTAGS,
  DEPOP_PLATFORM,
  depopPackSchema,
  type RawExportPacks,
} from "./schema";
import {
  FACEBOOK_PICKUP_LINE,
  MERCARI_SHIPPING_SUFFIX,
  buildCoreDescription,
  buildFacebookDescription,
  buildMercariDescription,
  buildNumericGrounding,
  derivableHashtagBodies,
  deriveDefaultHashtags,
  fallbackFacebookTitle,
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
  titleViolations,
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
 *    is derivable from the core (whitelist), titles are grounded on TOKEN
 *    BOUNDARIES against the core (with deterministic fallbacks), DESCRIPTIONS
 *    are assembled deterministically from the core (model description text is
 *    NEVER published — the only sound defense against invented digit-free
 *    claims), and the price line comes ONLY from the caller-resolved effective
 *    price — never from the model;
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

  it("publishes the deterministic core-built FB description (≤ cap) regardless of model rambling", async () => {
    const ramble = "These headphones are truly wonderful in every way. ".repeat(40);
    const { generate } = scriptedGenerate([
      { ...GOOD_RAW, facebook: { ...GOOD_RAW.facebook, description: ramble } },
    ]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    expect(res.facebook.pack.description).toBe(buildFacebookDescription(CORE));
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

  it("the published Mercari description always mentions shipping (deterministic suffix)", async () => {
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    expect(res.mercari.pack.description).toMatch(/ship/i);
    expect(res.mercari.pack.description).toContain(MERCARI_SHIPPING_SUFFIX);
  });

  it("publishes the deterministic core-built Mercari description, never model text", async () => {
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({ attributes: CORE, generate });
    expect(res.mercari.pack.description).toBe(buildMercariDescription(CORE));
    expect(res.mercari.pack.description).not.toBe(GOOD_RAW.mercari.description);
  });

  it("caps the deterministic description at the Mercari limit even for a spec-heavy core", async () => {
    const heavy: ExtractedAttributes = {
      ...CORE,
      specs: Array.from({ length: 40 }, (_, i) => `very long descriptive spec line number item ${"x".repeat(20)}${i}`),
    };
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({ attributes: heavy, generate });
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
  it("carries the caller-provided effective price on every platform pack", async () => {
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({
      attributes: CORE,
      generate,
      price: 177.77,
    });

    for (const platform of [res.facebook, res.mercari]) {
      expect(platform.price).toBe(177.77);
      expect(platform.copy.fields["price"]).toBe(177.77);
    }
  });

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

describe("published descriptions are deterministic core-backed assembly", () => {
  /** Helper: every numeric token in `text` is contextually grounded in CORE. */
  function ungrounded(text: string): string[] {
    return findUngroundedNumbers(text, buildNumericGrounding(CORE));
  }

  it("invented digit-free claims never publish: model descriptions are discarded without a retry", async () => {
    // "Includes charger" / "Waterproof" carry no digits, so no numeric check
    // can catch them — the defense is that model description text is simply
    // never published. No retry is needed or spent.
    const dirty: RawExportPacks = {
      ...GOOD_RAW,
      facebook: { ...GOOD_RAW.facebook, description: "Includes charger." },
      mercari: { ...GOOD_RAW.mercari, description: "Waterproof. Ships fast." },
    };
    const { generate, calls } = scriptedGenerate([dirty]);
    const res = await generateExportPacks({ attributes: CORE, generate, maxRetries: 1 });

    expect(calls.length).toBe(1);
    expect(res.facebook.pack.description).toBe(buildFacebookDescription(CORE));
    expect(res.mercari.pack.description).toBe(buildMercariDescription(CORE));
    expect(res.facebook.copyBlock).not.toContain("charger");
    expect(res.mercari.copyBlock).not.toContain("Waterproof");
    expect(facebookPackSchema.safeParse(res.facebook.pack).success).toBe(true);
    expect(mercariPackSchema.safeParse(res.mercari.pack).success).toBe(true);
  });

  it("a model-written '$50' in the FB description is never published and costs no retry", async () => {
    const dirty: RawExportPacks = {
      ...GOOD_RAW,
      facebook: {
        ...GOOD_RAW.facebook,
        description: "Great Sony headphones, asking $50 or best offer.",
      },
    };
    const { generate, calls } = scriptedGenerate([dirty]);
    const res = await generateExportPacks({ attributes: CORE, generate, maxRetries: 1 });

    // The description is not a published model surface, so no retry is spent.
    expect(calls.length).toBe(1);
    // The claim is NOT published: deterministic core-only assembly instead.
    expect(res.facebook.pack.description).toBe(buildFacebookDescription(CORE));
    expect(res.facebook.pack.description).not.toContain("$");
    expect(res.facebook.pack.description).not.toContain("50");
    expect(facebookPackSchema.safeParse(res.facebook.pack).success).toBe(true);
  });

  it("an unsupported number in the model's Mercari description is never published", async () => {
    const dirty: RawExportPacks = {
      ...GOOD_RAW,
      mercari: {
        ...GOOD_RAW.mercari,
        description:
          "Sony WH-1000XM4 headphones, includes a 25W charger. Ships fast.",
      },
    };
    const { generate, calls } = scriptedGenerate([dirty]);
    const res = await generateExportPacks({ attributes: CORE, generate, maxRetries: 1 });

    expect(calls.length).toBe(1);
    expect(res.mercari.pack.description).toBe(buildMercariDescription(CORE));
    expect(res.mercari.pack.description).not.toContain("25");
    // The deterministic build still honors the Mercari shipping convention.
    expect(res.mercari.pack.description).toMatch(/ship/i);
    expect(mercariPackSchema.safeParse(res.mercari.pack).success).toBe(true);
  });

  it("even a perfectly clean model description is not published — only core-backed assembly is", async () => {
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
    expect(res.facebook.pack.description).toBe(buildFacebookDescription(core));
    // The core spec still reaches the buyer — via the deterministic build.
    expect(res.facebook.pack.description).toContain("128GB case");
  });

  it("the deterministic builds satisfy both strict schemas and contain no ungrounded numbers", () => {
    const fb = buildFacebookDescription(CORE);
    const mercari = buildMercariDescription(CORE);
    expect(
      facebookPackSchema.safeParse({ title: "t", description: fb }).success,
    ).toBe(true);
    expect(
      mercariPackSchema.safeParse({ title: "t", description: mercari, hashtags: [] })
        .success,
    ).toBe(true);
    expect(mercari).toMatch(/ship/i);
    expect(ungrounded(fb)).toEqual([]);
    expect(ungrounded(mercari)).toEqual([]);
    // A bare core still yields non-empty, schema-valid text.
    expect(buildCoreDescription({}).length).toBeGreaterThan(0);
    expect(ungrounded(buildFacebookDescription({}))).toEqual([]);
  });

  it("grounds numbers by CONTEXT: digits mined out of identifiers never license standalone numbers", () => {
    // CORE's model is WH-1000XM4, so the bare digit "4" exists in the core —
    // but "Includes 4 charging cables" is a different CLAIM and must violate.
    expect(ungrounded("Includes 4 charging cables.")).toEqual(["4"]);
  });

  it("the stored price never grounds free text: '50-hour battery' violates even at price 50", () => {
    const grounding = buildNumericGrounding(CORE);
    // The price is deliberately ABSENT from the grounding context, so an effective
    // price of 50 cannot license "50-hour battery" (or any other 50-claim).
    expect(findUngroundedNumbers("50-hour battery life.", grounding)).toEqual([
      "50-hour",
    ]);
  });

  it("buildNumericGrounding carries core tokens and standalone numbers, never the price", () => {
    const grounding = buildNumericGrounding({
      ...CORE,
      specs: [...CORE.specs!, "2 ear pads included"],
    });
    expect(grounding.coreTokens.has("wh-1000xm4")).toBe(true);
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
    // A standalone number matching a standalone core number passes.
    const withCount = buildNumericGrounding({ ...CORE, specs: ["2 cables"] });
    expect(findUngroundedNumbers("Comes with 2 cables.", withCount)).toEqual([]);
  });

  it("packsHallucinateAttributes covers hashtags and titles; model descriptions are ignored", () => {
    expect(packsHallucinateAttributes(GOOD_RAW, CORE)).toBe(false);
    // A dirty model description does NOT burn a retry — it is never published.
    expect(
      packsHallucinateAttributes(
        {
          ...GOOD_RAW,
          facebook: { ...GOOD_RAW.facebook, description: "Asking $50." },
        },
        CORE,
      ),
    ).toBe(false);
    // A dirty TITLE (a published model surface) still flags.
    expect(
      packsHallucinateAttributes(
        {
          ...GOOD_RAW,
          facebook: { ...GOOD_RAW.facebook, title: "Sony WH-1000XM5" },
        },
        CORE,
      ),
    ).toBe(true);
  });
});

describe("token-boundary numeric grounding (no substring licensing)", () => {
  it("core '128GB' does NOT license a generated '8GB'; the exact token still passes", () => {
    const grounding = buildNumericGrounding({ ...CORE, specs: ["128GB"] });
    expect(findUngroundedNumbers("Comes with 8GB of storage.", grounding)).toEqual([
      "8gb",
    ]);
    expect(findUngroundedNumbers("Comes with 128GB of storage.", grounding)).toEqual(
      [],
    );
  });

  it("core '150-hour' does NOT license a generated '50-hour'", () => {
    const grounding = buildNumericGrounding({
      ...CORE,
      specs: ["150-hour battery"],
    });
    expect(findUngroundedNumbers("Up to 50-hour battery life.", grounding)).toEqual([
      "50-hour",
    ]);
    expect(findUngroundedNumbers("Up to 150-hour battery life.", grounding)).toEqual(
      [],
    );
  });

  it("identifier fragments no longer pass: '1000XM4' alone is not a core token", () => {
    // Under substring matching "1000XM4" leaked through because it appears
    // inside "wh-1000xm4"; token-boundary equality rejects it.
    const grounding = buildNumericGrounding(CORE);
    expect(findUngroundedNumbers("The 1000XM4 model.", grounding)).toEqual([
      "1000xm4",
    ]);
    expect(findUngroundedNumbers("The WH-1000XM4 model.", grounding)).toEqual([]);
  });

  it("a changed-specification title ('8GB' from a 128GB core) is replaced with the fallback title", async () => {
    const core: ExtractedAttributes = { ...CORE, specs: ["128GB"] };
    const dirty: RawExportPacks = {
      ...GOOD_RAW,
      facebook: { ...GOOD_RAW.facebook, title: "Sony WH-1000XM4 8GB headphones" },
    };
    const { generate, calls } = scriptedGenerate([dirty, dirty]);
    const res = await generateExportPacks({ attributes: core, generate, maxRetries: 1 });
    expect(calls.length).toBe(2);
    expect(res.facebook.pack.title).toBe(fallbackFacebookTitle(core));
    expect(res.facebook.pack.title).not.toContain("8GB");
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

describe("title guard rejects digit-free invented claims (#15 round 5)", () => {
  const attrs = {
    brand: "Sony",
    model: "WH-1000XM4",
    category: "electronics",
    condition: "good",
    title: "Sony WH-1000XM4 Wireless Headphones",
  };

  it("flags 'Includes Charger' / 'Waterproof' style tokens that no core value backs", () => {
    const grounding = buildNumericGrounding(attrs);
    expect(titleViolations("Sony WH-1000XM4 Includes Charger", grounding)).toContain("includes");
    expect(titleViolations("Sony WH-1000XM4 Waterproof Headphones", grounding)).toContain("waterproof");
    // Connectives and core-grounded words (incl. the vision title's) pass.
    expect(titleViolations("Sony WH-1000XM4 Wireless Headphones for electronics", grounding)).toEqual([]);
  });

  it("an invented digit-free title claim drives retry then the deterministic fallback", async () => {
    let calls = 0;
    const generate = async () => {
      calls += 1;
      return {
        facebook: { title: "Sony WH-1000XM4 Includes Charger", description: "" },
        mercari: {
          title: "Sony WH-1000XM4 Waterproof",
          description: "",
          hashtags: ["#sony"],
        },
      };
    };
    const packs = await generateExportPacks({ attributes: attrs, price: 120, generate });
    expect(calls).toBe(2); // one self-correction retry
    expect(packs.facebook.pack.title).not.toMatch(/charger/i);
    expect(packs.mercari.pack.title).not.toMatch(/waterproof/i);
    expect(packs.facebook.copyBlock).not.toMatch(/charger/i);
    expect(packs.mercari.copyBlock).not.toMatch(/waterproof/i);
  });
});

/**
 * DEPOP — the third honest export destination (issue #378). Depop has no title
 * field and no publish API, so its pack is assembled ENTIRELY from the
 * validated core: there is no model free-text channel at all, and therefore no
 * new hallucination surface. The description is keyword-first (Depop's search
 * weights the opening words heaviest) and capped at Depop's 1000-character
 * limit; hashtags reuse the same core-derived whitelist as Mercari, bounded at
 * Depop's 5.
 */
describe("generateExportPacks — Depop", () => {
  it("returns a schema-valid, core-only Depop pack mapped onto ListingCopy", async () => {
    const { generate } = scriptedGenerate([GOOD_RAW]);
    const res = await generateExportPacks({
      attributes: CORE,
      price: 120,
      generate,
      model: "test-model",
    });

    expect(depopPackSchema.safeParse(res.depop.pack).success).toBe(true);
    expect(res.depop.pack.description.length).toBeLessThanOrEqual(
      DEPOP_DESCRIPTION_MAX_LENGTH,
    );
    expect(res.depop.pack.hashtags.length).toBeLessThanOrEqual(DEPOP_MAX_HASHTAGS);

    // Keyword-first: the opening words are the core's own identity, not filler.
    expect(res.depop.pack.description.startsWith("Sony WH-1000XM4")).toBe(true);

    const copy = listingCopySchema.parse(res.depop.copy);
    expect(copy.platform).toBe(DEPOP_PLATFORM);
    expect(copy.fields["copyBlock"]).toBe(res.depop.copyBlock);
    expect(res.depop.price).toBe(120);
  });
});
