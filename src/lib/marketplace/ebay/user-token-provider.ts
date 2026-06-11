import type { SupabaseClient } from "@supabase/supabase-js";
import type { EbayTokenProvider } from "./types";
import { EbayApiError } from "./types";
import { ebayApiBaseUrl } from "./oauth";
import {
  getDecryptedConnection,
  updateCachedAccessToken,
} from "./connections";

/**
 * Per-user token provider (issue #17) — the production half of the
 * `EbayTokenProvider` swap that auth.ts (EnvTokenProvider) documents.
 *
 * Token lifecycle: the connection row caches the latest access token
 * (encrypted) with its expiry. A call within the expiry window decrypts and
 * reuses it; otherwise the stored refresh token mints a new one via the
 * refresh-token grant (same exchange as EnvTokenProvider, but against the
 * SELLER'S OWN tokens) and writes it back for the next call. The HTTP adapter
 * is unchanged — it only ever sees `getAccessToken()`.
 */

/** The scope the inventory publish flow needs (mirrors auth.ts). */
const SELL_INVENTORY_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.inventory";

/** Refresh this many ms before actual expiry. */
const EXPIRY_SLACK_MS = 60_000;

export interface UserTokenProviderOptions {
  fetch?: typeof fetch;
  env?: () => Record<string, string | undefined>;
  now?: () => number;
}

export class UserTokenProvider implements EbayTokenProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly readEnv: () => Record<string, string | undefined>;
  private readonly now: () => number;

  constructor(
    /** The request's USER-SCOPED client — RLS pins the connection row. */
    private readonly supabase: SupabaseClient,
    options: UserTokenProviderOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.readEnv = options.env ?? (() => process.env);
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(): Promise<string> {
    const env = this.readEnv();
    const connection = await getDecryptedConnection(this.supabase, env);
    if (!connection) {
      throw new Error(
        "No eBay account is connected. Connect one in Settings before publishing.",
      );
    }

    if (
      connection.accessToken &&
      connection.accessTokenExpiresAt &&
      connection.accessTokenExpiresAt - EXPIRY_SLACK_MS > this.now()
    ) {
      return connection.accessToken;
    }

    const clientId = env.EBAY_CLIENT_ID;
    const clientSecret = env.EBAY_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error(
        "eBay app credentials are not configured: set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET.",
      );
    }

    const res = await this.fetchImpl(
      `${ebayApiBaseUrl(env)}/identity/v1/oauth2/token`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: connection.refreshToken,
          scope: SELL_INVENTORY_SCOPE,
        }).toString(),
      },
    );

    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      throw new EbayApiError(
        `eBay user-token refresh failed (HTTP ${res.status}) — the seller may need to reconnect their eBay account in Settings`,
        res.status,
        body,
      );
    }

    const { access_token: token, expires_in: expiresIn } = (body ?? {}) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!token) {
      throw new EbayApiError(
        "eBay user-token refresh returned no access_token",
        res.status,
        body,
      );
    }

    const expiresAt = this.now() + (expiresIn ?? 0) * 1000;
    await updateCachedAccessToken(
      this.supabase,
      connection.userId,
      token,
      expiresAt,
      env,
    );
    return token;
  }
}
