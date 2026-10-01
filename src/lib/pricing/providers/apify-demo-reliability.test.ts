import { describe, expect, it, vi } from "vitest";
import { createInMemoryTtlCache } from "../comp-cache";
import { priceToConfidence } from "../../confidence/from-price";
import { createApifySoldPricingProvider, type ApifySoldComp, type RunApifySoldActor } from "./apify-sold";

const macbook = { brand: "Apple", model: "MacBook Pro", category: "Laptop", condition: "good", conditionKnown: true, specs: ["14-inch display", "48GB memory"] };
const now = Date.parse("2026-09-30T12:00:00Z");
function sale(title: string, price: number, id: number, extras = {}) {
  return { url: `https://www.ebay.com/itm/13456789000${id}`, title, soldPrice: String(price), soldCurrency: "USD", endedAt: "2026-09-29T12:00:00Z", condition: "Pre-Owned", isBestOfferAccepted: false, ...extras };
}
function provider(runActor: RunApifySoldActor) {
  const cache = createInMemoryTtlCache<ApifySoldComp[]>(60_000, Date.now, "shared");
  const write = vi.spyOn(cache, "set");
  return { cache, write, price: createApifySoldPricingProvider({ enabled: true, token: "offline-placeholder", cache, runActor, now: () => now }).price };
}

describe("bounded demo sold research", () => {
  it("broadens precise MacBook research twice, preserving screen size and labeling configuration differences", async () => {
    const runActor = vi.fn<RunApifySoldActor>().mockResolvedValueOnce({ status: "SUCCEEDED", items: [] })
      .mockResolvedValueOnce({ status: "SUCCEEDED", items: [sale("Apple MacBook Pro 14-inch 16GB", 900, 1), sale("Apple MacBook Pro 14-inch 16GB", 1000, 2)] })
      .mockResolvedValue({ status: "SUCCEEDED", items: [] });
    const result = await provider(runActor).price(macbook);
    expect(runActor.mock.calls.map(([r]) => r.input.keywords[0])).toEqual(["Apple MacBook Pro 14-inch 48GB", "Apple MacBook Pro", "Apple Laptop"]);
    expect(runActor.mock.calls.map(([r]) => r.input.count)).toEqual([30, 50, 50]);
    expect(runActor.mock.calls[0]?.[0]).toMatchObject({ timeoutSecs: 120, waitSecs: 125, maxTotalChargeUsd: 0.25, restartOnError: false });
    expect(result).not.toBeNull();
    expect(result?.evidence).toHaveLength(2);
    expect(result?.evidence?.every(r => r.title?.startsWith("Model family match:") && r.priceDisclosure === "displayed-sold-price")).toBe(true);
    expect(result?.sources.every(r => r.kind === "family-sold-comp")).toBe(true);
    expect(priceToConfidence(macbook, result!, { autopilotEnabled: false }).score).toBeLessThan(0.75);
  });

  it("shows a lone true sale as limited evidence rather than declining it", async () => {
    const runActor = vi.fn<RunApifySoldActor>().mockResolvedValueOnce({ status: "SUCCEEDED", items: [sale("Apple AirPods Pro", 90, 1)] }).mockResolvedValue({ status: "SUCCEEDED", items: [] });
    const signal = { brand: "Apple", model: "AirPods Pro", category: "Wireless earbuds", condition: "good", conditionKnown: true };
    const result = await provider(runActor).price(signal);
    expect(result?.evidence).toHaveLength(1);
    expect(result?.evidence?.[0]?.title).toMatch(/^Single sold comparison:/);
    expect(result?.compAgreement).toBeLessThanOrEqual(0.3);
    expect(priceToConfidence(signal, result!, { autopilotEnabled: false }).score).toBeLessThan(0.75);
  });

  it("researches a specific product category without manufacturing brand/model and visibly marks its broader sales", async () => {
    const runActor = vi.fn<RunApifySoldActor>().mockResolvedValue({ status: "SUCCEEDED", items: [sale("Generic Mechanical Keyboard", 50, 1), sale("Compact Mechanical Keyboard", 70, 2)] });
    const result = await provider(runActor).price({ category: "Mechanical keyboard", condition: "good", conditionKnown: true });
    expect(runActor).toHaveBeenCalled();
    expect(result?.evidence?.every(r => r.title?.startsWith("Category comparison:") && r.priceDisclosure === "displayed-sold-price")).toBe(true);
    expect(result?.sources.every(r => r.kind === "category-sold-comp")).toBe(true);
    expect(priceToConfidence({ category: "Mechanical keyboard" }, result!, { autopilotEnabled: false }).score).toBeLessThan(0.5);
  });

  it.each(["TIMED-OUT", "FAILED"])("expands a known terminal %s into actual family evidence", async status => {
    const runActor = vi.fn<RunApifySoldActor>().mockResolvedValueOnce({ status, items: [] })
      .mockResolvedValueOnce({ status: "SUCCEEDED", items: [sale("Apple MacBook Pro 14-inch 16GB", 900, 1), sale("Apple MacBook Pro 14-inch 16GB", 1000, 2)] })
      .mockResolvedValue({ status: "SUCCEEDED", items: [] });
    const result = await provider(runActor).price(macbook);
    expect(runActor).toHaveBeenCalledTimes(3);
    expect(result?.evidence).toHaveLength(2);
    expect(result?.sources.every(row => row.kind === "family-sold-comp")).toBe(true);
  });

  it("retains a thin exact shoe sale while adding disclosed size differences", async () => {
    const runActor = vi.fn<RunApifySoldActor>().mockResolvedValueOnce({ status: "SUCCEEDED", items: [sale("Nike Air Max 90 size 10", 90, 1)] })
      .mockResolvedValueOnce({ status: "SUCCEEDED", items: [sale("Nike Air Max 90 size 9", 70, 2), sale("Nike Air Max 90 size 11", 80, 3)] })
      .mockResolvedValue({ status: "SUCCEEDED", items: [] });
    const result = await provider(runActor).price({ brand: "Nike", model: "Air Max 90", category: "Sneakers", condition: "good", specs: ["size 10"] });
    expect(result?.evidence).toHaveLength(3);
    expect(result?.evidence?.filter(row => row.title?.startsWith("Model family match:"))).toHaveLength(2);
    expect(result?.sources.filter(row => row.kind === "sold-comp")).toHaveLength(1);
  });

  it("an ambiguous paid start stays fenced while a different item can research", async () => {
    const runActor = vi.fn<RunApifySoldActor>().mockRejectedValueOnce(new Error("request failed after start"))
      .mockResolvedValue({ status: "SUCCEEDED", items: [sale("Apple AirPods Pro", 90, 1), sale("Apple AirPods Pro", 100, 2), sale("Apple AirPods Pro", 95, 3)] });
    const p = provider(runActor);
    expect(await p.price(macbook)).toBeNull();
    expect(await p.price(macbook)).toBeNull();
    expect(runActor).toHaveBeenCalledTimes(1);
    expect((await p.price({ brand: "Apple", model: "AirPods Pro", condition: "good" }))?.evidence).toHaveLength(3);
    expect(runActor).toHaveBeenCalledTimes(2);
  });

  it("prices from exact evidence while preserving labeled broader category cards", async () => {
    const runActor = vi.fn<RunApifySoldActor>().mockResolvedValueOnce({ status: "SUCCEEDED", items: [sale("Apple AirPods Pro Wireless Earbuds", 150, 1)] })
      .mockResolvedValueOnce({ status: "SUCCEEDED", items: [] })
      .mockResolvedValue({ status: "SUCCEEDED", items: [2, 3, 4, 5].map(id => sale("Generic Wireless Earbuds", 20, id)) });
    const result = await provider(runActor).price({ brand: "Apple", model: "AirPods Pro", category: "Wireless earbuds", condition: "good" });
    expect(result?.suggested).toBe(150);
    expect(result?.range).toEqual({ min: 150, max: 150 });
    expect(result?.evidence).toHaveLength(5);
    expect(result?.sources.filter(row => row.kind === "category-sold-comp")).toHaveLength(4);
    expect(result?.sources.some(row => row.url.endsWith("001"))).toBe(true);
  });

  it("expands when three precise anchors are stale instead of letting them mask fresh family sales", async () => {
    const runActor = vi.fn<RunApifySoldActor>().mockResolvedValueOnce({ status: "SUCCEEDED", items: [1, 2, 3].map(id => sale("Apple MacBook Pro 14-inch 48GB", 1500, id, { endedAt: "2026-01-01T12:00:00Z" })) })
      .mockResolvedValueOnce({ status: "SUCCEEDED", items: [sale("Apple MacBook Pro 14-inch 16GB", 900, 4), sale("Apple MacBook Pro 14-inch 16GB", 1000, 5)] })
      .mockResolvedValue({ status: "SUCCEEDED", items: [] });
    const result = await provider(runActor).price(macbook);
    expect(runActor).toHaveBeenCalledTimes(3);
    expect(result?.evidence).toHaveLength(2);
    expect(result?.sources.every(row => row.kind === "family-sold-comp")).toBe(true);
  });

  it("keeps one exact sale below eligibility with every identification field resolved", async () => {
    const runActor = vi.fn<RunApifySoldActor>().mockResolvedValueOnce({ status: "SUCCEEDED", items: [sale("Apple AirPods Pro", 90, 1)] }).mockResolvedValue({ status: "SUCCEEDED", items: [] });
    const signal = { brand: "Apple", model: "AirPods Pro", category: "Wireless earbuds", condition: "good", upc: "194253397168", isbn: "9780306406157" };
    const result = await provider(runActor).price(signal);
    expect(result?.compAgreement).toBe(0.3);
    const confidence = priceToConfidence(signal, result!, { autopilotEnabled: true });
    expect(confidence.score).toBeCloseTo(0.655);
    expect(confidence.autopilotEligible).toBe(false);
  });

  it("never caches empty successes and permits a later independent research attempt", async () => {
    const runActor = vi.fn<RunApifySoldActor>().mockResolvedValue({ status: "SUCCEEDED", items: [] });
    const p = provider(runActor);
    expect(await p.price(macbook)).toBeNull();
    expect(await p.price(macbook)).toBeNull();
    expect(runActor).toHaveBeenCalledTimes(6);
    expect(p.write).not.toHaveBeenCalled();
  });

  it("keeps unknown accepted amounts and accessory/parts listings out of broader sold evidence", async () => {
    const runActor = vi.fn<RunApifySoldActor>().mockResolvedValue({ status: "SUCCEEDED", items: [
      sale("Apple MacBook Pro 14-inch 16GB", 900, 1, { isBestOfferAccepted: true }),
      sale("Apple MacBook Pro Replacement Charger", 30, 2),
      sale("Apple MacBook Pro 14-inch FOR PARTS", 60, 3),
    ] });
    const p = provider(runActor);
    expect(await p.price(macbook)).toBeNull();
    expect(runActor).toHaveBeenCalledTimes(3);
    expect(p.write).not.toHaveBeenCalled();
  });
});
