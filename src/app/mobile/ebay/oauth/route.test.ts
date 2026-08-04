import { describe, expect, it } from "vitest";

import { GET } from "./route";

describe("legacy iOS eBay OAuth callback bridge", () => {
  it.each([
    "connected",
    "declined",
    "cancelled",
    "expired",
    "wrong_tenant",
    "invalid_state",
    "in_progress",
    "failed",
  ])("redirects the server result %s to the owned app scheme", (result) => {
    const response = GET(
      new Request(`https://snaplist.dev/mobile/ebay/oauth?result=${result}`),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `snaplist://ebay/oauth?result=${result}`,
    );
  });

  it("fails closed when the callback result is missing or unknown", () => {
    for (const url of [
      "https://snaplist.dev/mobile/ebay/oauth",
      "https://snaplist.dev/mobile/ebay/oauth?result=published",
    ]) {
      const response = GET(new Request(url));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(
        "snaplist://ebay/oauth?result=failed",
      );
    }
  });
});
