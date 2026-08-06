import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompExtractor, webCompListSchema } from "./web-search";
import { createOpenAIRetailExtractor, retailFindingListSchema } from "./depreciation";
import type { ItemSignal } from "../types";
import type { SearchResult } from "./web-search";

/**
 * The WIRING between the model-facing schemas and the internal domain shapes
 * (issue #696).
 *
 * The pure repair functions (`webCompFromRaw`, `retailFindingFromRaw`) are unit
 * tested next to their tiers, and `llm/contracts.test.ts` walks the compiled
 * schemas. Neither proves the default extractors actually CALL the repair: both
 * `.map(...)` lines could be deleted and every other suite would still pass,
 * because every other test injects a fake extractor that never touches this
 * code path. That is the whole production path on `LLM_PROVIDER=openai`.
 *
 * So this file exercises the real `createOpenAI*Extractor` factories with the AI
 * SDK and the provider registry mocked out — no network, no keys — and asserts
 * (a) the schema handed to `generateObject` is the model-facing one, and (b) a
 * `title: null` from the model arrives at the caller as an ABSENT key.
 */

const generateObject = vi.hoisted(() => vi.fn());

vi.mock("ai", () => ({ generateObject }));
vi.mock("../../llm", () => ({
  resolveLanguageModel: vi.fn(async () => "fake-model-handle"),
  resolveModelId: vi.fn(() => "fake-model-id"),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const SIGNAL: ItemSignal = {
  brand: "Sony",
  model: "WH-1000XM4",
  category: "electronics",
  condition: "good",
  conditionKnown: true,
};

const RESULTS: SearchResult[] = [
  { url: "https://www.ebay.com/itm/1", title: "Sony WH-1000XM4 — SOLD", snippet: "$178" },
  { url: "https://www.walmart.com/ip/2", title: "Sony WH-1000XM4", snippet: "$110 new" },
];

describe("createOpenAICompExtractor wiring (#696)", () => {
  it("sends the model-facing comp schema and repairs `title: null` to an absent key", async () => {
    generateObject.mockResolvedValue({
      object: {
        comps: [
          { url: "https://www.ebay.com/itm/1", title: null, price: 178, kind: "sold" },
          { url: "https://www.ebay.com/itm/2", title: "   ", price: 185, kind: "sold" },
          { url: "https://www.ebay.com/itm/3", title: "Sony XM4 Black", price: 190, kind: "asking" },
        ],
      },
    });

    const comps = await createOpenAICompExtractor()({
      signal: SIGNAL,
      query: "Sony WH-1000XM4 sold",
      results: RESULTS,
    });

    // (a) the compiled artifact the strict-mode guard walks is the one actually sent.
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(generateObject.mock.calls[0][0].schema).toBe(webCompListSchema);

    // (b) the repair ran. Without `.map(webCompFromRaw)` these would be `null`/`"   "`,
    // and a `null` reaching `PriceSource.title` fails the `.strict()` price-result
    // contract downstream.
    expect(comps.map((c) => "title" in c)).toEqual([false, false, true]);
    expect(comps[2].title).toBe("Sony XM4 Black");
    expect(comps.map((c) => c.price)).toEqual([178, 185, 190]);
    expect(comps.map((c) => c.kind)).toEqual(["sold", "sold", "asking"]);
  });
});

describe("createOpenAIRetailExtractor wiring (#696)", () => {
  it("sends the model-facing retail schema and repairs `title: null` to an absent key", async () => {
    generateObject.mockResolvedValue({
      object: {
        findings: [
          { url: "https://www.walmart.com/ip/2", title: null, price: 110 },
          { url: "https://www.target.com/p/3", title: "  Sony XM4 — new  ", price: 120 },
        ],
      },
    });

    const findings = await createOpenAIRetailExtractor()({
      signal: SIGNAL,
      query: "Sony WH-1000XM4 retail price new",
      results: RESULTS,
    });

    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(generateObject.mock.calls[0][0].schema).toBe(retailFindingListSchema);

    expect(findings.map((f) => "title" in f)).toEqual([false, true]);
    expect(findings[1].title).toBe("Sony XM4 — new");
    expect(findings.map((f) => f.price)).toEqual([110, 120]);
  });
});
