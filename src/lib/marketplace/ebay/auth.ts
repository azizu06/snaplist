import type { SupabaseClient } from "@supabase/supabase-js";
import type { EbayTokenProvider } from "./types";
import { EbayApiError } from "./types";
import { bindEbaySandboxFallback } from "./connections";
import { UserTokenProvider } from "./user-token-provider";

/**
 * App-level (env-credential) token provider for the eBay Sell API — the sandbox
 * wiring for issue #14. Two env-driven modes, checked in order:
 *
 *  1. `EBAY_OAUTH_TOKEN` — a pre-minted USER access token. Quickest sandbox
 *     loop: mint one in the eBay developer console ("Get a User Token") and
 *     paste it. No network call; expires after ~2h, fine for manual testing.
 *  2. `EBAY_REFRESH_TOKEN` + `EBAY_CLIENT_ID`/`EBAY_CLIENT_SECRET` — the
 *     refresh-token grant. The refresh token is minted ONCE via the
 *     authorization-code flow for the sandbox seller; this provider exchanges
 *     it for short-lived access tokens and caches them until shortly before
 *     expiry.
 *
 * NOTE on grant choice: the Sell Inventory and member-messaging APIs require a
 * USER token, so the client-credentials grant is NOT sufficient. Connected
 * sellers use `UserTokenProvider`; this provider composes only the restricted
 * one-operator Sandbox fallback. HTTP adapters see the same token interface.
 *
 * Credentials are read LAZILY (per call, from the injected env reader), never at
 * module load, so importing the adapter never explodes in environments without
 * eBay credentials (tests, CI, fresh checkouts).
 */

/** The scope the inventory publish flow needs. */
const SELL_INVENTORY_SCOPE = "https://api.ebay.com/oauth/api_scope/sell.inventory";

/** Refresh the cached token this many ms before its actual expiry. */
const EXPIRY_SLACK_MS = 60_000;
const DEFAULT_TOKEN_REFRESH_TIMEOUT_MS = 30_000;
const MAX_TOKEN_REFRESH_TIMEOUT_MS = 2 * 60_000;

export interface EnvTokenProviderOptions {
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Injectable env reader; defaults to process.env. Read lazily per call. */
  env?: () => Record<string, string | undefined>;
  /** Injectable clock for cache-expiry tests. */
  now?: () => number;
  /** Refresh-token scopes for the composing adapter. */
  scopes?: string[];
}

export class EnvTokenProvider implements EbayTokenProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly readEnv: () => Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly scopes: string[];

  private cached?: { token: string; expiresAt: number };

  constructor(options: EnvTokenProviderOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.readEnv = options.env ?? (() => process.env);
    this.now = options.now ?? Date.now;
    this.scopes = options.scopes ?? [SELL_INVENTORY_SCOPE];
  }

  async getAccessToken(
    _expectedAccountGeneration?: string,
    parentSignal?: AbortSignal,
  ): Promise<string> {
    const env = this.readEnv();

    // Mode 1: pre-minted user access token (fast sandbox loop).
    const staticToken = env.EBAY_OAUTH_TOKEN;
    if (staticToken) return staticToken;

    // Mode 2: refresh-token grant.
    const refreshToken = env.EBAY_REFRESH_TOKEN;
    const clientId = env.EBAY_CLIENT_ID;
    const clientSecret = env.EBAY_CLIENT_SECRET;
    if (!refreshToken || !clientId || !clientSecret) {
      throw new Error(
        "eBay credentials are not configured. Set EBAY_OAUTH_TOKEN (quick sandbox " +
          "testing) or EBAY_REFRESH_TOKEN + EBAY_CLIENT_ID + EBAY_CLIENT_SECRET " +
          "(refresh-token grant). See docs/ebay-sandbox.md; per-user OAuth lands in #17.",
      );
    }

    if (this.cached && this.cached.expiresAt - EXPIRY_SLACK_MS > this.now()) {
      return this.cached.token;
    }

    const baseUrl = env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com";
    const configuredTimeout = Number(env.EBAY_TOKEN_REFRESH_TIMEOUT_MS);
    const timeoutMs =
      Number.isFinite(configuredTimeout) && configuredTimeout > 0
        ? Math.min(configuredTimeout, MAX_TOKEN_REFRESH_TIMEOUT_MS)
        : DEFAULT_TOKEN_REFRESH_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, timeoutSignal])
      : timeoutSignal;
    const res = await this.fetchImpl(`${baseUrl}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: this.scopes.join(" "),
      }).toString(),
      signal,
    });

    const body: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      throw new EbayApiError(
        `eBay token refresh failed (HTTP ${res.status})`,
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
        "eBay token refresh returned no access_token",
        res.status,
        body,
      );
    }

    this.cached = {
      token,
      expiresAt: this.now() + (expiresIn ?? 0) * 1000,
    };
    return token;
  }
}

export class OperatorSandboxTokenProvider implements EbayTokenProvider {
  private readonly envProvider: EnvTokenProvider;
  private readonly dispatchProvider: UserTokenProvider;

  constructor(
    private readonly supabase: SupabaseClient,
    private readonly userId: string,
    private readonly sellerId: string,
    private readonly scheduled: boolean,
    options: EnvTokenProviderOptions = {},
  ) {
    this.envProvider = new EnvTokenProvider({
      ...options,
      scopes: options.scopes ?? [SELL_INVENTORY_SCOPE],
    });
    this.dispatchProvider = new UserTokenProvider(supabase, {
      userId,
      scheduled,
    });
  }

  async beginProviderDispatch(
    resourceId: string,
    operation: "publish" | "reprice",
    expectedConnectionGeneration?: string | null,
    expectedPublishClaimId?: string | null,
  ) {
    if (expectedConnectionGeneration) {
      throw new Error(
        "eBay Sandbox fallback cannot use a connected-seller generation",
      );
    }
    const boundGeneration = await bindEbaySandboxFallback(
      this.supabase,
      this.userId,
      this.sellerId,
      this.scheduled,
    );
    const lease = await this.dispatchProvider.beginProviderDispatch(
      resourceId,
      operation,
      null,
      expectedPublishClaimId,
    );
    if (lease.accountGeneration !== boundGeneration) {
      await lease.release();
      throw new Error("eBay Sandbox fallback account generation changed");
    }
    return lease;
  }

  async getAccessToken(
    expectedAccountGeneration?: string,
    parentSignal?: AbortSignal,
    expectedConnectionGeneration?: string | null,
  ): Promise<string> {
    if (expectedConnectionGeneration) {
      throw new Error(
        "eBay Sandbox fallback cannot use a connected-seller generation",
      );
    }
    const boundGeneration = await bindEbaySandboxFallback(
      this.supabase,
      this.userId,
      this.sellerId,
      this.scheduled,
    );
    if (
      expectedAccountGeneration &&
      expectedAccountGeneration !== boundGeneration
    ) {
      throw new Error("eBay Sandbox fallback account generation changed");
    }
    return this.envProvider.getAccessToken(boundGeneration, parentSignal);
  }
}
