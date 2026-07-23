import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runSoldCompsSmoke } from "./sold-comps-smoke";
import type { FetchPage } from "./providers/ebay-sold";

const FIXTURE_HTML = readFileSync(
  fileURLToPath(
    new URL("./providers/fixtures/ebay-sold.sample.html", import.meta.url),
  ),
  "utf8",
);

const SIGNAL = {
  brand: "Sony",
  model: "WH-1000XM4",
  category: "electronics",
  condition: "good",
  conditionKnown: true,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("runSoldCompsSmoke", () => {
  it("is inert by default while proving target URL construction and router fallback", async () => {
    const fetchPage = vi.fn(async () => FIXTURE_HTML) as FetchPage;
    const report = await runSoldCompsSmoke({
      mode: "dry-run",
      signal: SIGNAL,
      env: {
        EBAY_SOLD_PROXY_TEMPLATE:
          "https://proxy.example/fetch?token=super-secret&url={url}",
      },
      fetchPage,
    });

    expect(fetchPage).not.toHaveBeenCalled();
    expect(report.externalRequests).toBe(0);
    expect(report.targetUrl).toContain("LH_Sold=1");
    expect(report.targetUrl).toContain("LH_Complete=1");
    expect(report.egressMode).toBe("proxy");
    expect(report.status).toBe("fallback");
    expect(report.selectedTier).toBe("branded-web");
    expect(report.fallbackReason).toBe("dry-run-no-network");
    expect(JSON.stringify(report)).not.toContain("super-secret");
  });

  it("reports sold-comps success, selected tier, and source URLs from an offline fixture", async () => {
    const report = await runSoldCompsSmoke({
      mode: "live",
      signal: SIGNAL,
      env: {},
      fetchPage: async () => FIXTURE_HTML,
    });

    expect(report.status).toBe("success");
    expect(report.selectedTier).toBe("ebay-sold");
    expect(report.sourceUrls.length).toBeGreaterThanOrEqual(2);
    expect(report.sourceUrls.every((url) => url.startsWith("https://www.ebay.com/"))).toBe(
      true,
    );
    expect(report.fallbackReason).toBeUndefined();
    expect(report.externalRequests).toBe(1);
  });

  it("uses injected enabled configuration when the ambient environment disables sold comps", async () => {
    vi.stubEnv("EBAY_SOLD_ENABLED", "false");
    const fetchPage = vi.fn(async () => FIXTURE_HTML) as FetchPage;

    const report = await runSoldCompsSmoke({
      mode: "live",
      signal: SIGNAL,
      env: { EBAY_SOLD_ENABLED: "true" },
      fetchPage,
    });

    expect(fetchPage).toHaveBeenCalledOnce();
    expect(report.status).toBe("success");
    expect(report.selectedTier).toBe("ebay-sold");
    expect(report.externalRequests).toBe(1);
  });

  it("reports blocked egress and graceful deterministic router fallback", async () => {
    const blocked = (async () => {
      throw new Error("403 proxy-token=must-not-leak");
    }) as FetchPage;

    const report = await runSoldCompsSmoke({
      mode: "live",
      signal: SIGNAL,
      env: {},
      fetchPage: blocked,
    });

    expect(report.status).toBe("fallback");
    expect(report.selectedTier).toBe("branded-web");
    expect(report.fallbackReason).toBe("egress-blocked");
    expect(report.fallbackSimulated).toBe(true);
    expect(JSON.stringify(report)).not.toContain("must-not-leak");
  });

  it("rejects URL userinfo without exposing it or reaching the fetch seam", async () => {
    const fetchPage = vi.fn(async () => FIXTURE_HTML) as FetchPage;
    const report = await runSoldCompsSmoke({
      mode: "live",
      signal: SIGNAL,
      env: {
        EBAY_SOLD_BASE_URL: "https://operator:must-not-leak@www.ebay.com",
      },
      fetchPage,
    });

    expect(fetchPage).not.toHaveBeenCalled();
    expect(report.targetUrl).toBeNull();
    expect(report.externalRequests).toBe(0);
    expect(report.status).toBe("fallback");
    expect(report.fallbackReason).toBe("egress-blocked");
    expect(JSON.stringify(report)).not.toContain("operator");
    expect(JSON.stringify(report)).not.toContain("must-not-leak");
  });

  it("distinguishes a fetched no-results page from blocked egress", async () => {
    const urls: string[] = [];
    const fetchPage = vi.fn(async (url: string) => {
      urls.push(url);
      return "<html><body>No exact matches</body></html>";
    });
    const report = await runSoldCompsSmoke({
      mode: "live",
      signal: SIGNAL,
      env: {},
      fetchPage,
    });

    expect(report.status).toBe("fallback");
    expect(report.selectedTier).toBe("branded-web");
    expect(report.fallbackReason).toBe("no-usable-sold-comps");
    expect(report.externalRequests).toBe(1);
    expect(urls.map((url) => new URL(url).searchParams.get("_ipg"))).toEqual(["10"]);
  });
});
