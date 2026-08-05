import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createServerRpcClient,
  SERVER_RPC_AUTH_HEADER,
} from "./server-rpc-auth";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createServerRpcClient", () => {
  it("attaches server authority without replacing the tenant bearer", async () => {
    let requestHeaders: Headers | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requestHeaders = request.headers;
      return Response.json(null);
    }));

    const client = createServerRpcClient({
      supabaseURL: "https://project.supabase.co",
      apiKey: "sb_secret_test",
      serverRpcSecret: "server-rpc-secret-with-at-least-32-characters",
      bearerToken: "clerk-bearer-token",
    });

    await client.rpc("create_mobile_ebay_oauth_session", {
      p_idempotency_key: "67600000-0000-4000-8000-000000000011",
      p_proposed_session_id: "67600000-0000-4000-8000-000000000001",
    });

    expect(requestHeaders?.get(SERVER_RPC_AUTH_HEADER)).toBe(
      "server-rpc-secret-with-at-least-32-characters",
    );
    expect(requestHeaders?.get("authorization")).toBe(
      "Bearer clerk-bearer-token",
    );
  });
});
