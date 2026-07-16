import { describe, expect, it, vi } from "vitest";
import {
  fetchScrapingBeeUsedCredits,
  reconcileScrapingBeeCredits,
} from "./scrapingbee-client";
import type { ProviderQueryCapture } from "./types";

describe("ScrapingBee credit accounting", () => {
  it("reads usage with header auth and never places the API key in the URL", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        void input;
        void init;
        return Response.json({ used_api_credit: 1234 });
      },
    );
    const used = await fetchScrapingBeeUsedCredits({
      proxyTemplate:
        "https://app.scrapingbee.com/api/v1?api_key=super-secret&premium_proxy=true&render_js=false&url={url}",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(used).toBe(1234);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain("super-secret");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer super-secret",
    );
  });

  it("reconciles an account delta when an aborted response has no SPB-cost header", () => {
    const base = (status: ProviderQueryCapture["status"], credits: number): ProviderQueryCapture => ({
      provider: "scrapingbee-public-page",
      queryId: status,
      status,
      latencyMs: 8_000,
      attempts: 1,
      retries: 0,
      creditsSpent: credits,
      actualUsdSpent: 0,
      bestOfferPolicy: "excluded-by-parser",
      comps: [],
    });
    const reconciled = reconcileScrapingBeeCredits(
      [base("success", 10), base("blocked", 0)],
      20,
    );
    expect(reconciled).toEqual({
      accountDeltaCredits: 20,
      responseHeaderCredits: 10,
      unattributedCredits: 10,
    });
  });
});
