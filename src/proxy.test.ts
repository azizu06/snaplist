import type { NextFetchEvent } from "next/server";
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

  it("keeps only the self-authenticating Home route outside cookie middleware", () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`);

    expect(matcher.test("/v1/home")).toBe(false);
    expect(matcher.test("/v1/home/")).toBe(false);
    expect(matcher.test("/v1/home-other")).toBe(true);
    expect(matcher.test("/dashboard")).toBe(true);
  });
});
