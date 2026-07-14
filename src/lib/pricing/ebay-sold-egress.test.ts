import { describe, expect, it } from "vitest";
import {
  buildEbaySoldProxyRequestUrl,
  resolveEbaySoldEgressConfig,
} from "./ebay-sold-egress";

describe("eBay sold-comps egress configuration", () => {
  it("distinguishes missing optional proxy config from a configured proxy", () => {
    expect(resolveEbaySoldEgressConfig({})).toEqual({ mode: "direct" });
    expect(
      resolveEbaySoldEgressConfig({ EBAY_SOLD_PROXY_TEMPLATE: "  " }),
    ).toEqual({ mode: "direct" });

    const configured = resolveEbaySoldEgressConfig({
      EBAY_SOLD_PROXY_TEMPLATE: "https://proxy.example/fetch?key=secret&url={url}",
    });
    expect(configured.mode).toBe("proxy");
  });

  it("constructs one encoded proxy request URL deterministically", () => {
    const target =
      "https://www.ebay.com/sch/i.html?_nkw=Sony+WH-1000XM4&LH_Sold=1&LH_Complete=1";

    expect(
      buildEbaySoldProxyRequestUrl(
        "https://proxy.example/fetch?key=secret&url={url}",
        target,
      ),
    ).toBe(
      `https://proxy.example/fetch?key=secret&url=${encodeURIComponent(target)}`,
    );
  });

  it.each([
    "https://proxy.example/fetch",
    "https://proxy.example/fetch?first={url}&second={url}",
    "http://proxy.example/fetch?url={url}",
    "https://user:pass@proxy.example/fetch?url={url}",
    "https://proxy.example/fetch#url={url}",
  ])("rejects malformed config without echoing the configured value", (template) => {
    let message = "";
    try {
      resolveEbaySoldEgressConfig({ EBAY_SOLD_PROXY_TEMPLATE: template });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/Invalid EBAY_SOLD_PROXY_TEMPLATE/);
    expect(message).not.toContain(template);
  });
});
