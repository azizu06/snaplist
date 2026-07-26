import type { NextFetchEvent } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/nextjs/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@clerk/nextjs/server")>();

  return {
    ...actual,
    clerkMiddleware:
      (
        handler: (
          auth: () => Promise<{ userId: null }>,
          request: NextRequest,
        ) => Promise<Response>,
      ) =>
      (request: NextRequest) =>
        handler(async () => ({ userId: null }), request),
  };
});

import { config, proxy } from "./proxy";

function doesProxyMatch(pathname: string): boolean {
  return unstable_doesMiddlewareMatch({
    config,
    nextConfig: {},
    url: `https://snaplist.test${pathname}`,
  });
}

describe("auth proxy", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it("lets an authorized inbox-sync cron request reach its route handler", async () => {
    process.env.CRON_SECRET = "configured-cron-secret";
    const request = new NextRequest(
      "https://snaplist.test/api/cron/inbox-sync",
      {
        headers: { authorization: "Bearer configured-cron-secret" },
      },
    );

    const response = await proxy(request, {} as NextFetchEvent);

    if (!response) {
      throw new Error("Expected the proxy to return a response");
    }

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  it("keeps the native bearer surface outside cookie middleware", () => {
    for (const pathname of [
      "/v1",
      "/v1/home",
      "/v1/items/runs",
      "/v1/runs/33333333-3333-4333-8333-333333333333",
      "/v1/ebay/oauth/sessions",
    ]) {
      expect(doesProxyMatch(pathname)).toBe(false);
    }

    expect(doesProxyMatch("/v1x")).toBe(true);
    expect(doesProxyMatch("/v10/home")).toBe(true);
    expect(doesProxyMatch("/dashboard")).toBe(true);
  });

  it("lets only the exact eBay OAuth callback bypass cookie authentication", async () => {
    const callbackResponse = await proxy(
      new NextRequest("https://snaplist.test/v1/ebay/oauth/callback"),
      {} as NextFetchEvent,
    );
    if (!callbackResponse) {
      throw new Error("Expected the proxy to return a response");
    }
    expect(callbackResponse.status).toBe(200);
    expect(callbackResponse.headers.get("x-middleware-next")).toBe("1");

    const nonGetCallbackResponse = await proxy(
      new NextRequest("https://snaplist.test/v1/ebay/oauth/callback", {
        method: "POST",
      }),
      {} as NextFetchEvent,
    );
    if (!nonGetCallbackResponse) {
      throw new Error("Expected the proxy to return a response");
    }
    expect(nonGetCallbackResponse.status).toBe(307);
    expect(nonGetCallbackResponse.headers.get("location")).toBe(
      "https://snaplist.test/login?next=%2Fv1%2Febay%2Foauth%2Fcallback",
    );

    const protectedResponse = await proxy(
      new NextRequest("https://snaplist.test/v1/ebay/oauth/sessions"),
      {} as NextFetchEvent,
    );
    if (!protectedResponse) {
      throw new Error("Expected the proxy to return a response");
    }
    expect(protectedResponse.status).toBe(307);
    expect(protectedResponse.headers.get("location")).toBe(
      "https://snaplist.test/login?next=%2Fv1%2Febay%2Foauth%2Fsessions",
    );
  });

  it("still redirects an unauthenticated web caller to login", async () => {
    const dashboardResponse = await proxy(
      new NextRequest("https://snaplist.test/dashboard"),
      {} as NextFetchEvent,
    );
    if (!dashboardResponse) {
      throw new Error("Expected the proxy to return a response");
    }
    expect(dashboardResponse.status).toBe(307);
    expect(dashboardResponse.headers.get("location")).toBe(
      "https://snaplist.test/login?next=%2Fdashboard",
    );
  });
});
