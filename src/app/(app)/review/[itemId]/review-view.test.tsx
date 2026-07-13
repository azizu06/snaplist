import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewView, type ReviewData } from "./review-view";

const noop = async () => {};

function reviewData(status = "draft"): ReviewData {
  return {
    itemId: "item-1",
    photoUrls: [],
    identification: {
      label: "Sony WH-1000XM4",
      confident: true,
      reason: null,
      candidates: [],
      evidence: 1,
    },
    attrs: [
      { key: "brand", value: "Sony" },
      { key: "model", value: "WH-1000XM4" },
      { key: "category", value: "electronics" },
      { key: "condition", value: "Good" },
      { key: "isbn", value: null },
      { key: "upc", value: "027242919662" },
    ],
    specs: ["wireless", "noise-cancelling"],
    listing: {
      id: "listing-1",
      platform: "ebay",
      title: "Sony WH-1000XM4 Wireless Headphones",
      description: "Tested and working.",
      status,
    },
    suggested: 165,
    override: 199,
    displayPrice: 199,
    costBasis: null,
    measurements: null,
    range: { low: 145, high: 185 },
    confidence: 0.6,
    tier: "ebay-sold",
    sources: [],
    strategies: [],
    clarifyOptions: [{ label: "Black", spec: "black" }],
    banner: null,
    actionError: null,
  };
}

describe("review identity correction UI", () => {
  it("renders the bounded editor and explicit regeneration action without removing Sharpen", () => {
    const html = renderToStaticMarkup(
      <ReviewView
        data={reviewData()}
        saveAction={noop}
        sharpenAction={noop}
        regenerateAction={noop}
      />,
    );

    for (const name of [
      "brand",
      "model",
      "category",
      "condition",
      "isbn",
      "upc",
      "specifications",
    ]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain("Re-price &amp; regenerate");
    expect(html).toContain("Your saved price override is kept");
    expect(html).toContain("Sharpen the estimate");
    expect(html).toContain(">Re-price<");
  });

  it("does not offer pre-publish regeneration for an already published listing", () => {
    const html = renderToStaticMarkup(
      <ReviewView
        data={reviewData("published")}
        saveAction={noop}
        sharpenAction={noop}
        regenerateAction={noop}
      />,
    );
    expect(html).not.toContain("Correct item identity");
    expect(html).not.toContain("Re-price &amp; regenerate");
  });
});
