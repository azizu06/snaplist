import { describe, expect, it } from "vitest";
import { buildSellerPushMessage, sellerPushCopyViolations } from "./message";

/**
 * Issue #891. What a push is allowed to say.
 *
 * A push arrives while the seller is doing something else and cannot be taken
 * back, so a sentence that overstates what happened is worse here than anywhere
 * else in the product. The item name is model-generated, which means the copy
 * rules have to hold for a name nobody reviewed.
 */
describe("seller push copy (#891)", () => {
  it("names the item and the state when a listing is ready", () => {
    const message = buildSellerPushMessage({
      moment: "listingReady",
      itemName: "Sony WH-1000XM4",
    });

    expect(message.title).toBe("Sony WH-1000XM4 is ready to review");
    expect(message.body).toBe(
      "Open SnapList to check the details before you publish.",
    );
  });

  it("names the item and the state when a publish is confirmed", () => {
    const message = buildSellerPushMessage({
      moment: "listingPublished",
      itemName: "Sony WH-1000XM4",
    });

    expect(message.title).toBe("Sony WH-1000XM4 is live on eBay");
    expect(message.body).toBe("Open SnapList to view or edit it.");
  });

  it("says the same thing without a name when there is no usable one", () => {
    for (const itemName of [null, "   ", "Sony — headphones"]) {
      expect(
        buildSellerPushMessage({ moment: "listingReady", itemName }).title,
      ).toBe("Your listing is ready to review");
      expect(
        buildSellerPushMessage({ moment: "listingPublished", itemName }).title,
      ).toBe("Your listing is live on eBay");
    }
  });

  it.each([
    ["a currency amount", "Sony WH-1000XM4 sold for $240"],
    ["a bare currency code", "Your listing is worth 240 USD"],
    ["a sale", "Your listing sold on eBay"],
    ["a buyer", "A buyer is asking about your listing"],
    ["an offer", "Your listing has an offer waiting"],
  ])("rejects %s", (_label, title) => {
    expect(
      sellerPushCopyViolations({ title, body: "Open SnapList." }),
    ).not.toEqual([]);
  });

  it("rejects the vocabulary the seller-copy contract already bans", () => {
    expect(
      sellerPushCopyViolations({
        title: "Your listing is ready",
        body: "The worker finished its lease.",
      }),
    ).toContain("internal-error");
  });

  it("passes its own contract for every message it builds", () => {
    const moments = ["listingReady", "listingPublished"] as const;
    for (const moment of moments) {
      for (const itemName of ["Sony WH-1000XM4", "Nintendo Switch OLED", null]) {
        expect(
          sellerPushCopyViolations(buildSellerPushMessage({ moment, itemName })),
        ).toEqual([]);
      }
    }
  });

  it("drops a model-supplied name that would smuggle a price into the title", () => {
    const message = buildSellerPushMessage({
      moment: "listingReady",
      itemName: "Sony WH-1000XM4 worth $240",
    });

    expect(message.title).toBe("Your listing is ready to review");
    expect(sellerPushCopyViolations(message)).toEqual([]);
  });
});
