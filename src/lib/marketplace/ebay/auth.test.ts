import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { EnvTokenProvider, OperatorSandboxTokenProvider } from "./auth";
import { EbayApiError } from "./types";

/**
 * App-level token provider tests (issue #14). Everything offline: fetch is a
 * fake; NO live eBay call. Per-user OAuth replaces this provider in #17.
 */

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("EnvTokenProvider", () => {
  it("returns EBAY_OAUTH_TOKEN directly when set (quick sandbox mode, no network)", async () => {
    const fetchSpy = vi.fn();
    const provider = new EnvTokenProvider({
      fetch: fetchSpy as unknown as typeof fetch,
      env: () => ({ EBAY_OAUTH_TOKEN: "static-user-token" }),
    });
    await expect(provider.getAccessToken()).resolves.toBe("static-user-token");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails with a readable error (pointing at docs/#17) when nothing is configured", async () => {
    const provider = new EnvTokenProvider({
      fetch: vi.fn() as unknown as typeof fetch,
      env: () => ({}),
    });
    await expect(provider.getAccessToken()).rejects.toThrowError(
      /EBAY_OAUTH_TOKEN|EBAY_REFRESH_TOKEN/,
    );
  });

  it("exchanges the refresh token via the OAuth endpoint with Basic client auth", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(200, { access_token: "fresh-token", expires_in: 7200 }),
    );
    const provider = new EnvTokenProvider({
      fetch: fetchSpy as unknown as typeof fetch,
      env: () => ({
        EBAY_BASE_URL: "https://api.sandbox.ebay.com",
        EBAY_CLIENT_ID: "client-id",
        EBAY_CLIENT_SECRET: "client-secret",
        EBAY_REFRESH_TOKEN: "refresh-me",
      }),
    });

    await expect(provider.getAccessToken()).resolves.toBe("fresh-token");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://api.sandbox.ebay.com/identity/v1/oauth2/token");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    const params = new URLSearchParams(String(init.body));
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh-me");
    expect(params.get("scope")).toContain("sell.inventory");
  });

  it("uses the composing adapter's requested scopes for app-level Sandbox refresh", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(200, { access_token: "message-token", expires_in: 7200 }),
    );
    const scopes = [
      "https://api.ebay.com/oauth/api_scope",
      "https://api.ebay.com/oauth/api_scope/commerce.message",
    ];
    const provider = new EnvTokenProvider({
      fetch: fetchSpy as unknown as typeof fetch,
      env: () => ({
        EBAY_CLIENT_ID: "client-id",
        EBAY_CLIENT_SECRET: "client-secret",
        EBAY_REFRESH_TOKEN: "refresh-me",
      }),
      scopes,
    });

    await provider.getAccessToken();

    const [, init] = fetchSpy.mock.calls[0]! as unknown as [string, RequestInit];
    const params = new URLSearchParams(String(init.body));
    expect(params.get("scope")).toBe(scopes.join(" "));
  });

  it("caches the access token until shortly before expiry, then refreshes", async () => {
    let nowMs = 0;
    const fetchSpy = vi.fn(async () =>
      jsonResponse(200, { access_token: `token-${fetchSpy.mock.calls.length}`, expires_in: 7200 }),
    );
    const provider = new EnvTokenProvider({
      fetch: fetchSpy as unknown as typeof fetch,
      env: () => ({
        EBAY_CLIENT_ID: "id",
        EBAY_CLIENT_SECRET: "secret",
        EBAY_REFRESH_TOKEN: "rt",
      }),
      now: () => nowMs,
    });

    const first = await provider.getAccessToken();
    const second = await provider.getAccessToken();
    expect(second).toBe(first);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Jump past expiry (7200s) — must refresh.
    nowMs = 7200_000 + 1;
    await provider.getAccessToken();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("throws EbayApiError carrying status + body on a failed grant", async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse(400, { error: "invalid_grant" }),
    );
    const provider = new EnvTokenProvider({
      fetch: fetchSpy as unknown as typeof fetch,
      env: () => ({
        EBAY_CLIENT_ID: "id",
        EBAY_CLIENT_SECRET: "secret",
        EBAY_REFRESH_TOKEN: "rt",
      }),
    });

    const err = await provider.getAccessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EbayApiError);
    expect((err as EbayApiError).status).toBe(400);
    expect((err as EbayApiError).body).toEqual({ error: "invalid_grant" });
  });
});

describe("OperatorSandboxTokenProvider", () => {
  it("requires the database-bound fallback generation before returning credentials", async () => {
    const rpc = vi.fn(async () => ({
      data: "33333333-3333-4333-8333-333333333333",
      error: null,
    }));
    const provider = new OperatorSandboxTokenProvider(
      { rpc } as unknown as SupabaseClient,
      "operator-tenant",
      "sandbox-seller-id",
      true,
      { env: () => ({ EBAY_OAUTH_TOKEN: "sandbox-token" }) },
    );

    await expect(
      provider.getAccessToken("33333333-3333-4333-8333-333333333333"),
    ).resolves.toBe("sandbox-token");
    expect(rpc).toHaveBeenCalledWith("bind_scheduled_ebay_sandbox_fallback", {
      p_user_id: "operator-tenant",
      p_seller_id: "sandbox-seller-id",
    });
  });

  it("rejects historical message generations before exposing fallback credentials", async () => {
    const provider = new OperatorSandboxTokenProvider(
      {
        rpc: vi.fn(async () => ({
          data: "44444444-4444-4444-8444-444444444444",
          error: null,
        })),
      } as unknown as SupabaseClient,
      "operator-tenant",
      "sandbox-seller-id",
      false,
      { env: () => ({ EBAY_OAUTH_TOKEN: "sandbox-token" }) },
    );

    await expect(
      provider.getAccessToken("55555555-5555-4555-8555-555555555555"),
    ).rejects.toThrow("account generation changed");
  });
});
