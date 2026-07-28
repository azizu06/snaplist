import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  EbayPublishBindingProvenance,
  EbayTokenProvider,
} from "./types";
import { EbayApiError } from "./types";
import { ebayApiBaseUrl } from "./oauth";
import {
  beginEbayProviderDispatch,
  endEbayProviderDispatch,
  getDecryptedConnection,
  renewEbayProviderDispatch,
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
const DEFAULT_TOKEN_REFRESH_TIMEOUT_MS = 30_000;
const MAX_TOKEN_REFRESH_TIMEOUT_MS = 2 * 60_000;
const PROVIDER_DISPATCH_RENEW_MS = 60_000;

export interface UserTokenProviderOptions {
  fetch?: typeof fetch;
  env?: () => Record<string, string | undefined>;
  now?: () => number;
  /** Required when the caller uses a service-role client (background sync). */
  userId?: string;
  scheduled?: boolean;
}

export class UserTokenProvider implements EbayTokenProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly readEnv: () => Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly userId?: string;
  private readonly scheduled: boolean;

  constructor(
    /** RLS client for foreground work, or scheduled server client using pinned RPCs. */
    private readonly supabase: SupabaseClient,
    options: UserTokenProviderOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.readEnv = options.env ?? (() => process.env);
    this.now = options.now ?? Date.now;
    this.userId = options.userId;
    this.scheduled = options.scheduled ?? false;
  }

  async beginProviderDispatch(
    resourceId: string,
    operation: "publish" | "reprice",
    expectedConnectionGeneration?: string | null,
    expectedPublishClaimId?: string | null,
    expectedPublishBinding?: EbayPublishBindingProvenance | null,
  ) {
    const {
      accountGeneration,
      connectionGeneration,
      publishClaimId,
      attemptToken,
      userId,
    } = await beginEbayProviderDispatch(
      this.supabase,
      resourceId,
      operation,
      expectedConnectionGeneration,
      expectedPublishClaimId,
      expectedPublishBinding,
      this.scheduled,
    );
    if (this.scheduled && userId !== this.userId) {
      await endEbayProviderDispatch(
        this.supabase,
        resourceId,
        operation,
        accountGeneration,
        connectionGeneration,
        publishClaimId,
        attemptToken,
        true,
      ).catch(() => undefined);
      throw new Error("Scheduled eBay dispatch tenant does not match its resource");
    }
    const controller = new AbortController();
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing || controller.signal.aborted) return;
      renewing = true;
      void renewEbayProviderDispatch(
        this.supabase,
        resourceId,
        operation,
        accountGeneration,
        connectionGeneration,
        publishClaimId,
        attemptToken,
        this.scheduled,
      )
        .catch((error) => {
          controller.abort(error);
        })
        .finally(() => {
          renewing = false;
        });
    }, PROVIDER_DISPATCH_RENEW_MS);
    timer.unref?.();

    return {
      accountGeneration,
      connectionGeneration,
      publishClaimId,
      attemptToken,
      signal: controller.signal,
      release: async () => {
        clearInterval(timer);
        await endEbayProviderDispatch(
          this.supabase,
          resourceId,
          operation,
          accountGeneration,
          connectionGeneration,
          publishClaimId,
          attemptToken,
          this.scheduled,
        ).catch(() => undefined);
      },
    };
  }

  async getAccessToken(
    expectedAccountGeneration?: string,
    parentSignal?: AbortSignal,
    expectedConnectionGeneration?: string | null,
  ): Promise<string> {
    const env = this.readEnv();
    const connection = await getDecryptedConnection(
      this.supabase,
      env,
      this.userId,
      this.scheduled,
    );
    if (!connection) {
      throw new Error(
        "No eBay account is connected. Connect one in Settings before publishing.",
      );
    }
    if (
      expectedAccountGeneration &&
      connection.accountGeneration !== expectedAccountGeneration
    ) {
      throw new Error("eBay account generation changed before provider dispatch");
    }
    if (
      expectedConnectionGeneration
      && connection.connectionGeneration !== expectedConnectionGeneration
    ) {
      throw new Error("eBay connection generation changed before provider dispatch");
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

    const refreshSignal = tokenRefreshSignal(env, parentSignal);
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
          // Preserve exactly the scopes granted to this connection. New
          // connections include the traditional-API base scope for messaging;
          // existing publish-only connections keep working and are prompted to
          // reconnect only when they actually use messaging.
          scope:
            connection.scopes.length > 0
              ? connection.scopes.join(" ")
              : SELL_INVENTORY_SCOPE,
        }).toString(),
        signal: refreshSignal,
      },
    );

    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      throw new EbayApiError(
        `eBay user-token refresh failed (HTTP ${res.status}); the seller may need to reconnect their eBay account in Settings`,
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
      connection.accountGeneration,
      token,
      expiresAt,
      env,
      this.scheduled,
    );
    return token;
  }
}

function tokenRefreshSignal(
  env: Record<string, string | undefined>,
  parentSignal?: AbortSignal,
): AbortSignal {
  const configured = Number(env.EBAY_TOKEN_REFRESH_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(configured) && configured > 0
      ? Math.min(configured, MAX_TOKEN_REFRESH_TIMEOUT_MS)
      : DEFAULT_TOKEN_REFRESH_TIMEOUT_MS;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return parentSignal
    ? AbortSignal.any([parentSignal, timeoutSignal])
    : timeoutSignal;
}
