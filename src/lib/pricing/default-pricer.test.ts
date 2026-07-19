import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetTtlCaches } from "./comp-cache";
import { createDefaultPricer } from "./default-pricer";
import type { RunApifySoldActor } from "./providers/apify-sold";
import type { ItemSignal } from "./types";

const SIGNAL: ItemSignal = {
  brand: "Sony",
  model: "WH-1000XM4",
  category: "electronics",
  condition: "good",
  conditionKnown: true,
};

const PUBLIC_SOLD_HTML = `
  <ul class="srp-results">
    <li class="s-item">
      <div class="s-item__title">Sony WH-1000XM4 Wireless Headphones</div>
      <div class="s-item__price">$170.00</div>
      <div class="s-item__caption">Sold Jul 10, 2026</div>
      <div class="s-item__subtitle">Pre-Owned</div>
      <a class="s-item__link" href="https://www.ebay.com/itm/public-a">A</a>
    </li>
    <li class="s-item">
      <div class="s-item__title">Sony WH-1000XM4 Wireless Headphones</div>
      <div class="s-item__price">$190.00</div>
      <div class="s-item__caption">Sold Jul 11, 2026</div>
      <div class="s-item__subtitle">Pre-Owned</div>
      <a class="s-item__link" href="https://www.ebay.com/itm/public-b">B</a>
    </li>
  </ul>
`;

function apifyItems() {
  return [
    {
      url: "https://www.ebay.com/itm/apify-a",
      title: "Sony WH-1000XM4 Wireless Headphones",
      condition: "Pre-Owned",
      endedAt: "2026-07-10T12:00:00.000Z",
      soldPrice: "175",
      soldCurrency: "USD",
    },
    {
      url: "https://www.ebay.com/itm/apify-b",
      title: "Sony WH-1000XM4 Wireless Headphones",
      condition: "Pre-Owned",
      endedAt: "2026-07-11T12:00:00.000Z",
      soldPrice: "185",
      soldCurrency: "USD",
    },
  ];
}

describe("createDefaultPricer Apify composition", () => {
  beforeEach(() => {
    __resetTtlCaches();
  });

  it("keeps the Apify candidate inert by default and preserves the public sold provider", async () => {
    const runActor = vi.fn<RunApifySoldActor>(async () => ({
      status: "SUCCEEDED",
      items: apifyItems(),
    }));
    const fetchPage = vi.fn(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: { enabled: false, token: "secret", runActor },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(result.suggested).toBe(190);
    expect(runActor).not.toHaveBeenCalled();
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("uses Apify first when explicitly enabled and does not call the public provider on success", async () => {
    const runActor = vi.fn<RunApifySoldActor>(async () => ({
      status: "SUCCEEDED",
      items: apifyItems(),
    }));
    const fetchPage = vi.fn(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: { enabled: true, token: "secret", runActor },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(result.suggested).toBe(185);
    expect(runActor).toHaveBeenCalledTimes(1);
    expect(fetchPage).not.toHaveBeenCalled();
  });

  it("falls through from Actor failure to the public sold provider without blocking listing pricing", async () => {
    const runActor = vi.fn<RunApifySoldActor>(async () => {
      throw new Error("actor unavailable");
    });
    const fetchPage = vi.fn(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: { enabled: true, token: "secret", runActor, emitDiagnostic: () => undefined },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(result.suggested).toBe(190);
    expect(runActor).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("falls through when Actor retrieval has fewer than two matcher-approved anchors", async () => {
    const runActor = vi.fn<RunApifySoldActor>(async () => ({
      status: "SUCCEEDED",
      items: [
        apifyItems()[0],
        {
          ...apifyItems()[1],
          title: "Sony WH-1000XM4 replacement case",
          soldPrice: "20",
        },
      ],
    }));
    const fetchPage = vi.fn(async () => PUBLIC_SOLD_HTML);
    const price = createDefaultPricer({
      apifySold: { enabled: true, token: "secret", runActor },
      ebaySold: { fetchPage },
    });

    const result = await price(SIGNAL);

    expect(result.tier).toBe("ebay-sold");
    expect(result.suggested).toBe(190);
    expect(runActor).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
