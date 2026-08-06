import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

  it("lets an authorized pipeline-worker scheduler request reach its route handler", async () => {
    process.env.CRON_SECRET = "configured-cron-secret";
    const request = new NextRequest(
      "https://snaplist.test/api/internal/pipeline-worker",
      {
        headers: { authorization: "Bearer configured-cron-secret" },
      },
    );

    const response = await proxy(request, {} as NextFetchEvent);

    if (!response) {
      throw new Error("Expected the proxy to return a response");
    }

    // A login redirect here silently drains nothing, forever. Vercel Cron
    // treats a 3xx as the final response for that invocation; pg_net instead
    // follows it and records a 200 login page, so the operator's response log
    // looks healthy while no work happened. Both failures are invisible.
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  it("lets an authorized pipeline-maintenance scheduler request reach its route handler", async () => {
    process.env.CRON_SECRET = "configured-cron-secret";
    const request = new NextRequest(
      "https://snaplist.test/api/internal/pipeline-maintenance",
      {
        headers: { authorization: "Bearer configured-cron-secret" },
      },
    );

    const response = await proxy(request, {} as NextFetchEvent);

    if (!response) {
      throw new Error("Expected the proxy to return a response");
    }

    // The same owner-only template that schedules the worker also schedules
    // this route hourly. Redirecting it means retention, guest-draft expiry,
    // and Storage cleanup never run while the schedule reports success.
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  it("lets an authorized included-offer-worker scheduler request reach its route handler", async () => {
    process.env.CRON_SECRET = "configured-cron-secret";
    const request = new NextRequest(
      "https://snaplist.test/api/internal/included-offer-worker",
      {
        headers: { authorization: "Bearer configured-cron-secret" },
      },
    );

    const response = await proxy(request, {} as NextFetchEvent);

    if (!response) {
      throw new Error("Expected the proxy to return a response");
    }

    // Issue #524's redemption queue has exactly one writer, and only this
    // worker moves a claim to `awaiting_device_token`. A login redirect here
    // does not merely slow the fence down: no seller is ever asked for a
    // DeviceCheck token, so the included first AI run becomes unobtainable
    // while the trigger keeps requiring a reserved claim. The route's own
    // handler test cannot see this — it invokes the handler directly.
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  // The owner-only pg_cron template is the hosted activation path, so every
  // route it schedules has to survive this proxy. Deriving the list from the
  // template rather than restating it means a newly scheduled route cannot be
  // added there while silently staying cookie-protected here.
  it("lets every route the owner-only pg_cron template schedules reach its handler", async () => {
    process.env.CRON_SECRET = "configured-cron-secret";
    const template = readFileSync(
      fileURLToPath(
        new URL(
          "../supabase/templates/pipeline-operations-cron.sql",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const scheduledPaths = [
      ...new Set(template.match(/\/api\/internal\/[a-z-]+/g) ?? []),
    ];

    expect(scheduledPaths).toEqual(
      expect.arrayContaining([
        "/api/internal/pipeline-worker",
        "/api/internal/pipeline-maintenance",
        "/api/internal/included-offer-worker",
      ]),
    );

    for (const pathname of scheduledPaths) {
      const response = await proxy(
        new NextRequest(`https://snaplist.test${pathname}`, {
          headers: { authorization: "Bearer configured-cron-secret" },
        }),
        {} as NextFetchEvent,
      );
      if (!response) {
        throw new Error(`Expected the proxy to return a response for ${pathname}`);
      }
      expect(`${pathname} ${response.status}`).toBe(`${pathname} 200`);
      expect(response.headers.get("location")).toBeNull();
    }
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

  it("keeps the eBay photo surface outside cookie middleware", () => {
    // eBay's picture fetcher holds no Clerk cookie; the opaque token is the
    // route's whole authentication contract. A login redirect here publishes
    // listings whose pictures eBay can never load.
    expect(doesProxyMatch(`/m/${"A".repeat(43)}`)).toBe(false);
    expect(doesProxyMatch("/m")).toBe(false);
    expect(doesProxyMatch("/m2/token")).toBe(true);
    expect(doesProxyMatch("/media")).toBe(true);
  });

  it("lets only the exact App Attest endpoint own its evidence boundary", () => {
    expect(doesProxyMatch("/api/app-attest")).toBe(false);
    expect(doesProxyMatch("/api/app-attest/")).toBe(false);
    expect(doesProxyMatch("/api/app-attest/child")).toBe(true);
    expect(doesProxyMatch("/api/app-attest-extra")).toBe(true);
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

  it("lets an unauthenticated visitor reach the public pricing page", async () => {
    const pricingResponse = await proxy(
      new NextRequest("https://snaplist.test/pricing"),
      {} as NextFetchEvent,
    );
    if (!pricingResponse) {
      throw new Error("Expected the proxy to return a response");
    }
    expect(pricingResponse.status).toBe(200);
    expect(pricingResponse.headers.get("x-middleware-next")).toBe("1");
    expect(pricingResponse.headers.get("location")).toBeNull();
  });

  it("lets Apple fetch the app-site association without a Clerk redirect", async () => {
    const response = await proxy(
      new NextRequest(
        "https://snaplist.test/.well-known/apple-app-site-association",
      ),
      {} as NextFetchEvent,
    );
    if (!response) {
      throw new Error("Expected the proxy to return a response");
    }

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  it("lets the legacy native OAuth callback bridge bypass Clerk", async () => {
    const response = await proxy(
      new NextRequest(
        "https://snaplist.test/mobile/ebay/oauth?result=connected",
      ),
      {} as NextFetchEvent,
    );
    if (!response) {
      throw new Error("Expected the proxy to return a response");
    }

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });
});
