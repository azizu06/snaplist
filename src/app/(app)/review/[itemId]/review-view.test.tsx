import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewView, reviewStateKey, type ReviewData } from "./review-view";

const noop = async () => {};

function reviewData(
  status = "draft",
  ebay: { listingId?: string | null; status?: string | null } = {},
): ReviewData {
  return {
    itemId: "item-1",
    reviewRevision: "00000000-0000-4000-8000-000000000001",
    reviewBlocked: false,
    runId: "run-1",
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
      ebayListingId: ebay.listingId ?? null,
      ebayStatus: ebay.status ?? null,
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
  it("changes the controlled-state key when any review write advances the revision", () => {
    const before = reviewData();
    const after = {
      ...before,
      reviewRevision: "00000000-0000-4000-8000-000000000002",
    };

    expect(reviewStateKey(after)).not.toBe(reviewStateKey(before));
  });

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
    expect(html.match(/name="reviewRevision"/g)).toHaveLength(3);
  });

  it("canonicalizes a persisted condition alias in the correction editor", () => {
    const data = reviewData();
    data.attrs = data.attrs.map((attribute) =>
      attribute.key === "condition" ? { ...attribute, value: "Very good" } : attribute,
    );
    const html = renderToStaticMarkup(
      <ReviewView
        data={data}
        saveAction={noop}
        sharpenAction={noop}
        regenerateAction={noop}
      />,
    );
    expect(html).toContain('name="condition" value="very-good"');
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

  it("does not offer regeneration when authoritative eBay fields say the listing is live", () => {
    const html = renderToStaticMarkup(
      <ReviewView
        data={reviewData("draft", {
          listingId: "v1|1234567890|0",
          status: "published",
        })}
        saveAction={noop}
        sharpenAction={noop}
        regenerateAction={noop}
      />,
    );
    expect(html).not.toContain("Correct item identity");
    expect(html).not.toContain("Re-price &amp; regenerate");
  });

  it("does not offer regeneration or sharpen when another eBay row is live", () => {
    const data = reviewData();
    data.reviewBlocked = true;
    const html = renderToStaticMarkup(
      <ReviewView
        data={data}
        saveAction={noop}
        sharpenAction={noop}
        regenerateAction={noop}
      />,
    );
    expect(html).not.toContain("Correct item identity");
    expect(html).not.toContain("Re-price &amp; regenerate");
    expect(html).not.toContain("Sharpen the estimate");
  });

  it.each([
    { listingId: "v1|1234567890|0", status: null },
    { listingId: null, status: "publishing" },
    { listingId: null, status: "published" },
  ])(
    "does not offer regeneration for server-blocked eBay state %#",
    (ebay) => {
      const html = renderToStaticMarkup(
        <ReviewView
          data={reviewData("draft", ebay)}
          saveAction={noop}
          sharpenAction={noop}
          regenerateAction={noop}
        />,
      );
      expect(html).not.toContain("Correct item identity");
      expect(html).not.toContain("Re-price &amp; regenerate");
      expect(html).not.toContain("Sharpen the estimate");
    },
  );
});
