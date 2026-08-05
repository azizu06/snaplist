import { afterEach, describe, expect, it, vi } from "vitest";
import { createSupabaseMobileEbayOauthSessionStore } from "./mobile-oauth-store";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Supabase mobile eBay OAuth session store", () => {
  it("forwards server RPC authority on tenant-bound calls", async () => {
    let requestHeaders: Headers | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requestHeaders = request.headers;
      return Response.json({
        session_id: "67600000-0000-4000-8000-000000000001",
        user_id: "user_server_rpc_header",
        expires_at: "2026-08-05T21:00:00.000Z",
      });
    }));

    const store = createSupabaseMobileEbayOauthSessionStore({
      supabaseURL: "https://project.supabase.co",
      secretKey: "sb_secret_test",
      serverRpcSecret: "server-rpc-secret-with-at-least-32-characters",
    });

    await store.createOrReplaySession({
      proposedSessionId: "67600000-0000-4000-8000-000000000001",
      idempotencyKey: "67600000-0000-4000-8000-000000000011",
      userId: "user_server_rpc_header",
      bearerToken: "clerk-bearer-token",
    });

    expect(requestHeaders?.get("x-snaplist-server-auth")).toBe(
      "server-rpc-secret-with-at-least-32-characters",
    );
    expect(requestHeaders?.get("authorization")).toBe(
      "Bearer clerk-bearer-token",
    );
  });
});
