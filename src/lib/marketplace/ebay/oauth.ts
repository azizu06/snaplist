import { EbayApiError } from "./types";

/**
 * eBay user OAuth (authorization-code grant) for per-user connections
 * (issue #17). Pure, injectable helpers — the route handlers own cookies and
 * redirects; this module owns URLs and token exchange.
 *
 * eBay quirk worth knowing: the `redirect_uri` parameter is NOT a URL — it is
 * the keyset's **RuName** (eBay's "Redirect URL name", e.g.
 * "Abduaziz_Umarov-Abduaziz-SnapLi-abcdef"). The actual callback URL
 * (https://<host>/api/ebay/callback) is configured against that RuName in the
 * developer portal. Sandbox and production keysets have DIFFERENT RuNames, so
 * `EBAY_RU_NAME` flips alongside the credentials.
 */

/** Scopes the per-user connection asks for: publish inventory, read identity
 * (what lets the account-deletion endpoint map eBay user -> tokens), and read
 * the seller's account config (business policies + merchant location — the
 * production flip discovers their ids through this; issue #17/#47). */
export const EBAY_OAUTH_SCOPES = [
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
  "https://api.ebay.com/oauth/api_scope/sell.account.readonly",
];

type Env = Record<string, string | undefined>;

/** Sell/identity API base — same default the rest of the adapter uses. */
export function ebayApiBaseUrl(env: Env): string {
  return env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com";
}

/** The user-consent host is separate from the API host and flips with it. */
export function ebayAuthorizeBaseUrl(env: Env): string {
  return ebayApiBaseUrl(env).includes("sandbox")
    ? "https://auth.sandbox.ebay.com"
    : "https://auth.ebay.com";
}

/**
 * The Commerce Identity API is served from the `apiz` host (apiz.ebay.com /
 * apiz.sandbox.ebay.com), NOT the Sell API's `api` host — calling getUser on
 * the wrong host fails every time, which would silently store null eBay
 * identifiers and break deletion-notice matching (Codex P1 on PR #46).
 */
export function ebayIdentityBaseUrl(env: Env): string {
  return ebayApiBaseUrl(env).includes("sandbox")
    ? "https://apiz.sandbox.ebay.com"
    : "https://apiz.ebay.com";
}

/** Build the consent-screen URL the connect route redirects the seller to. */
export function buildAuthorizeUrl(env: Env, state: string): string {
  const clientId = env.EBAY_CLIENT_ID;
  const ruName = env.EBAY_RU_NAME;
  if (!clientId || !ruName) {
    throw new Error(
      "eBay OAuth is not configured: set EBAY_CLIENT_ID and EBAY_RU_NAME " +
        "(the keyset's RuName from the eBay developer portal).",
    );
  }
  const url = new URL(`${ebayAuthorizeBaseUrl(env)}/oauth2/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ruName);
  url.searchParams.set("scope", EBAY_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export interface EbayTokenGrant {
  accessToken: string;
  /** Long-lived (~18 months); the credential we actually persist. */
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  accessTokenExpiresAt: number;
  scopes: string[];
}

/** Exchange the consent `code` for tokens. */
export async function exchangeAuthorizationCode(
  code: string,
  env: Env,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  now: () => number = Date.now,
): Promise<EbayTokenGrant> {
  const clientId = env.EBAY_CLIENT_ID;
  const clientSecret = env.EBAY_CLIENT_SECRET;
  const ruName = env.EBAY_RU_NAME;
  if (!clientId || !clientSecret || !ruName) {
    throw new Error(
      "eBay OAuth is not configured: set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET and EBAY_RU_NAME.",
    );
  }

  const res = await fetchImpl(`${ebayApiBaseUrl(env)}/identity/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: ruName,
    }).toString(),
  });

  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    throw new EbayApiError(
      `eBay code exchange failed (HTTP ${res.status})`,
      res.status,
      body,
    );
  }

  const {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    scope,
  } = (body ?? {}) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!accessToken || !refreshToken) {
    throw new EbayApiError(
      "eBay code exchange returned no access_token/refresh_token",
      res.status,
      body,
    );
  }

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: now() + (expiresIn ?? 0) * 1000,
    scopes: scope ? scope.split(" ") : EBAY_OAUTH_SCOPES,
  };
}

export interface EbayIdentity {
  userId: string;
  username: string;
}

/**
 * Resolve who the connected eBay account is. Best-effort: a null return means
 * "connected but identity unknown" — the connection still works for publishing;
 * only deletion-notice mapping degrades (handled there by username fallback).
 */
export async function fetchEbayIdentity(
  accessToken: string,
  env: Env,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<EbayIdentity | null> {
  try {
    const res = await fetchImpl(
      `${ebayIdentityBaseUrl(env)}/commerce/identity/v1/user/`,
      { headers: { authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { userId?: string; username?: string };
    if (!body.userId || !body.username) return null;
    return { userId: body.userId, username: body.username };
  } catch {
    return null;
  }
}
