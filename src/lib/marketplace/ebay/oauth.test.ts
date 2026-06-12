import { describe, expect, it } from "vitest";
import {
  EBAY_OAUTH_SCOPES,
  buildAuthorizeUrl,
  ebayApiBaseUrl,
  ebayAuthorizeBaseUrl,
  ebayIdentityBaseUrl,
  exchangeAuthorizationCode,
  fetchEbayIdentity,
} from "./oauth";
import { EbayApiError } from "./types";

const ENV = {
  EBAY_CLIENT_ID: "client-id",
  EBAY_CLIENT_SECRET: "client-secret",
  EBAY_RU_NAME: "Aziz-SnapList-ru-name",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("ebay oauth", () => {
  describe("EBAY_OAUTH_SCOPES (the connection's capability contract)", () => {
    it("covers publish, identity, and business-policy reads", () => {
      // sell.inventory: publish offers. commerce.identity.readonly: map eBay
      // user -> tokens for deletion notices. sell.account.readonly: read the
      // seller's business policies + merchant location at connect time (the
      // production flip needs their ids; issue #17 / #47 groundwork).
      expect(EBAY_OAUTH_SCOPES).toContain(
        "https://api.ebay.com/oauth/api_scope/sell.inventory",
      );
      expect(EBAY_OAUTH_SCOPES).toContain(
        "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
      );
      expect(EBAY_OAUTH_SCOPES).toContain(
        "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
      );
    });
  });

  describe("base urls (the sandbox -> production flip)", () => {
    it("defaults to sandbox and flips the consent host with EBAY_BASE_URL", () => {
      expect(ebayApiBaseUrl({})).toBe("https://api.sandbox.ebay.com");
      expect(ebayAuthorizeBaseUrl({})).toBe("https://auth.sandbox.ebay.com");

      const prod = { EBAY_BASE_URL: "https://api.ebay.com" };
      expect(ebayApiBaseUrl(prod)).toBe("https://api.ebay.com");
      expect(ebayAuthorizeBaseUrl(prod)).toBe("https://auth.ebay.com");
    });

    it("serves identity from the apiz host, never the Sell API host", () => {
      // getUser only exists on apiz.* — the api.* host 404s, which would
      // silently store null eBay ids and break deletion-notice matching.
      expect(ebayIdentityBaseUrl({})).toBe("https://apiz.sandbox.ebay.com");
      expect(ebayIdentityBaseUrl({ EBAY_BASE_URL: "https://api.ebay.com" })).toBe(
        "https://apiz.ebay.com",
      );
    });
  });

  describe("buildAuthorizeUrl", () => {
    it("encodes client id, RuName as redirect_uri, scopes and state", () => {
      const url = new URL(buildAuthorizeUrl(ENV, "state-123"));
      expect(url.origin).toBe("https://auth.sandbox.ebay.com");
      expect(url.pathname).toBe("/oauth2/authorize");
      expect(url.searchParams.get("client_id")).toBe("client-id");
      expect(url.searchParams.get("redirect_uri")).toBe("Aziz-SnapList-ru-name");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("state")).toBe("state-123");
      expect(url.searchParams.get("scope")).toBe(EBAY_OAUTH_SCOPES.join(" "));
    });

    it("names the missing env vars instead of building a broken URL", () => {
      expect(() => buildAuthorizeUrl({}, "s")).toThrow(/EBAY_CLIENT_ID/);
      expect(() => buildAuthorizeUrl({}, "s")).toThrow(/EBAY_RU_NAME/);
    });
  });

  describe("exchangeAuthorizationCode", () => {
    it("posts the code with Basic auth and returns the grant", async () => {
      let seen: { url: string; init: RequestInit } | undefined;
      const stubFetch: typeof fetch = async (input, init) => {
        seen = { url: String(input), init: init ?? {} };
        return jsonResponse(200, {
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 7200,
          scope: EBAY_OAUTH_SCOPES.join(" "),
        });
      };

      const grant = await exchangeAuthorizationCode(
        "the-code",
        ENV,
        stubFetch,
        () => 1_000_000,
      );

      expect(seen?.url).toBe(
        "https://api.sandbox.ebay.com/identity/v1/oauth2/token",
      );
      const headers = seen?.init.headers as Record<string, string>;
      expect(headers.authorization).toBe(
        `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
      );
      const params = new URLSearchParams(String(seen?.init.body));
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("the-code");
      expect(params.get("redirect_uri")).toBe("Aziz-SnapList-ru-name");

      expect(grant.accessToken).toBe("access-1");
      expect(grant.refreshToken).toBe("refresh-1");
      expect(grant.accessTokenExpiresAt).toBe(1_000_000 + 7200 * 1000);
      expect(grant.scopes).toEqual(EBAY_OAUTH_SCOPES);
    });

    it("throws a typed error with eBay's payload on a failed exchange", async () => {
      const stubFetch: typeof fetch = async () =>
        jsonResponse(400, { error: "invalid_grant" });
      await expect(
        exchangeAuthorizationCode("bad-code", ENV, stubFetch),
      ).rejects.toThrowError(EbayApiError);
    });

    it("treats a 200 without tokens as a failure, not a silent half-grant", async () => {
      const stubFetch: typeof fetch = async () =>
        jsonResponse(200, { access_token: "only-access" });
      await expect(
        exchangeAuthorizationCode("c", ENV, stubFetch),
      ).rejects.toThrow(/refresh_token/);
    });
  });

  describe("fetchEbayIdentity", () => {
    it("returns the eBay identity on success, calling the apiz host", async () => {
      let seenUrl = "";
      const stubFetch: typeof fetch = async (input) => {
        seenUrl = String(input);
        return jsonResponse(200, { userId: "ebay-uid", username: "seller_aziz" });
      };
      await expect(fetchEbayIdentity("tok", ENV, stubFetch)).resolves.toEqual({
        userId: "ebay-uid",
        username: "seller_aziz",
      });
      expect(seenUrl).toBe(
        "https://apiz.sandbox.ebay.com/commerce/identity/v1/user/",
      );
    });

    it("degrades to null on HTTP or network failure (identity is best-effort)", async () => {
      const failing: typeof fetch = async () => jsonResponse(403, {});
      await expect(fetchEbayIdentity("tok", ENV, failing)).resolves.toBeNull();

      const throwing: typeof fetch = async () => {
        throw new Error("network down");
      };
      await expect(fetchEbayIdentity("tok", ENV, throwing)).resolves.toBeNull();
    });
  });
});
