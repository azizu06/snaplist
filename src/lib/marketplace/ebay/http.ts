import type {
  EbayAdapter,
  EbayPublishFallbackBinding,
  EbayPublishRequest,
  EbayPublishCompletion,
  EbayPublishResult,
  EbayReviseRequest,
  EbayReviseCompletion,
  EbayReviseResult,
  EbayTokenProvider,
} from "./types";
import { EbayApiError, EbayWriteAmbiguousError } from "./types";
import { EnvTokenProvider } from "./auth";
import { marketplaceContentLanguage } from "./map";
import type { EbayPolicyLocationCandidates } from "./policy-location-contract";
import { HttpEbayPolicyLocationDiscoveryAdapter } from "./policy-location-http";

/**
 * The REAL eBay Sell API adapter (issue #14): publishes a listing with the
 * documented three-step Sell Inventory flow —
 *
 *   1. PUT  /sell/inventory/v1/inventory_item/{sku}      (upsert the product)
 *   2. POST /sell/inventory/v1/offer                     (create the offer)
 *   3. POST /sell/inventory/v1/offer/{offerId}/publish   (go live -> listingId)
 *
 * Sandbox vs production is ONLY `EBAY_BASE_URL` + credentials (PRD "Path to
 * real"): the default base is the sandbox; flipping the URL and the seller's
 * keys/policies is the entire promotion. No code change.
 *
 * Idempotency / retry shape:
 *  - The inventory PUT is an upsert keyed by SKU (SnapList uses the listing
 *    row's UUID), so re-publishing the same listing never multiplies inventory.
 *  - If the offer already exists for the SKU (eBay errorId 25002), the existing
 *    offerId is recovered from the error payload and UPDATED in place, then
 *    published — so a publish that failed halfway is safely re-runnable.
 *
 * Env (credentials, policy ids) is read LAZILY per call via the injected env
 * reader — never at module load — so importing this file is always safe and the
 * offline test suite (which uses MockEbayAdapter) needs none of it.
 */

export interface HttpEbayAdapterOptions {
  /** Injectable for tests; defaults to globalThis.fetch. NO live calls in tests. */
  fetch?: typeof fetch;
  /** Token source. Defaults to the env-credential provider; #17 swaps per-user. */
  tokenProvider?: EbayTokenProvider;
  /** Injectable env reader; defaults to process.env. Read lazily per call. */
  env?: () => Record<string, string | undefined>;
  /** Exact-operator Sandbox values; absent for every connected seller. */
  publishFallbackBinding?: EbayPublishFallbackBinding;
}

/** eBay's "offer entity already exists" error id (create-offer conflict). */
const OFFER_ALREADY_EXISTS = 25002;
const PROVIDER_DISPATCH_TIMEOUT_MS = 4 * 60_000;

interface EbayErrorPayload {
  errors?: Array<{
    errorId?: number;
    message?: string;
    parameters?: Array<{ name?: string; value?: string }>;
  }>;
}

export class HttpEbayAdapter implements EbayAdapter {
  private readonly fetchImpl: typeof fetch;
  private readonly tokenProvider: EbayTokenProvider;
  private readonly readEnv: () => Record<string, string | undefined>;
  private readonly publishFallbackBinding?: EbayPublishFallbackBinding;
  private readonly policyLocationDiscovery: HttpEbayPolicyLocationDiscoveryAdapter;

  constructor(options: HttpEbayAdapterOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.readEnv = options.env ?? (() => process.env);
    this.publishFallbackBinding = options.publishFallbackBinding;
    this.tokenProvider =
      options.tokenProvider ??
      new EnvTokenProvider({ fetch: options.fetch, env: options.env });
    // Read-only Sell Account/Inventory reads share this adapter's token
    // provider, fetch, and env so a seller's policies are always read with
    // THEIR credentials against the same configured base (issue #47).
    this.policyLocationDiscovery = new HttpEbayPolicyLocationDiscoveryAdapter({
      tokenProvider: this.tokenProvider,
      fetch: this.fetchImpl,
      env: this.readEnv,
    });
  }

  getPublishFallbackBinding(): EbayPublishFallbackBinding | undefined {
    return this.publishFallbackBinding;
  }

  /** Read-only per-connection policy/location discovery (issue #47). */
  discoverPolicyLocationCandidates(input: {
    marketplaceId: string;
    accountGeneration: string;
  }): Promise<EbayPolicyLocationCandidates> {
    return this.policyLocationDiscovery.readCandidates(input);
  }

  async publishListing(
    request: EbayPublishRequest,
    complete?: EbayPublishCompletion,
  ): Promise<EbayPublishResult> {
    const env = this.readEnv();
    const baseUrl = env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com";
    const marketplaceId = request.marketplaceId;
    // The Sell Inventory API requires Content-Language on create/update calls
    // and documents marketplace-specific locales — en-US against EBAY_DE can
    // reject the publish, so the locale must follow the marketplace flip.
    const contentLanguage = marketplaceContentLanguage(
      marketplaceId,
      env.EBAY_CONTENT_LANGUAGE,
    );

    // eBay requires at least one image to publish a listing. Fail fast LOCALLY
    // — before the token mint and before any Sell API write — so a doomed
    // publish never leaves partial remote state (inventory item / offer).
    if (request.imageUrls.length === 0) {
      throw new Error(
        `Cannot publish listing ${request.sku} to eBay: no image URLs were provided. ` +
          "eBay requires at least one photo. Add or re-upload the item's photos and retry.",
      );
    }

    const lease = await this.tokenProvider.beginProviderDispatch?.(
      request.sku,
      "publish",
      request.connectionGeneration,
      request.publishClaimId,
      request.connectionGeneration === null
        ? null
        : {
            marketplaceId: request.marketplaceId,
            fulfillmentPolicyId: request.fulfillmentPolicyId,
            paymentPolicyId: request.paymentPolicyId,
            returnPolicyId: request.returnPolicyId,
            merchantLocationKey: request.merchantLocationKey,
          },
    );
    const signal = providerDispatchSignal(lease?.signal);
    try {
      const token = await this.tokenProvider.getAccessToken(
        lease?.accountGeneration,
        signal,
        lease?.connectionGeneration,
      );

    // --- 1. Upsert the inventory item (idempotent by SKU). -------------------
    await this.call(
      token,
      "PUT",
      `${baseUrl}/sell/inventory/v1/inventory_item/${encodeURIComponent(request.sku)}`,
      {
        condition: request.condition,
        product: {
          title: request.title,
          description: request.description,
          aspects: request.aspects,
          imageUrls: request.imageUrls, // guaranteed non-empty by the guard above
        },
        availability: {
          shipToLocationAvailability: { quantity: request.quantity },
        },
      },
      contentLanguage,
      signal,
    );

    // --- 2. Create (or recover + update) the offer. ---------------------------
    const offerBody = {
      sku: request.sku,
      marketplaceId,
      format: "FIXED_PRICE",
      // Required by createOffer before an offer can publish; eBay mandates GTC
      // (Good 'Til Cancelled) as the only duration for fixed-price listings.
      listingDuration: "GTC",
      availableQuantity: request.quantity,
      categoryId: request.categoryId,
      listingDescription: request.description,
      listingPolicies: {
        fulfillmentPolicyId: request.fulfillmentPolicyId,
        paymentPolicyId: request.paymentPolicyId,
        returnPolicyId: request.returnPolicyId,
      },
      pricingSummary: { price: request.price },
      merchantLocationKey: request.merchantLocationKey,
    };

    let offerId: string;
    try {
      const created = await this.call<{ offerId?: string }>(
        token,
        "POST",
        `${baseUrl}/sell/inventory/v1/offer`,
        offerBody,
        contentLanguage,
        signal,
      );
      if (!created?.offerId) {
        throw new EbayWriteAmbiguousError(
          "eBay offer create returned no offerId",
          200,
          created,
        );
      }
      offerId = created.offerId;
    } catch (err) {
      if (!isOfferConflict(err)) throw err;
      // Offer already exists for this SKU (e.g. an earlier publish failed after
      // step 2 — or AFTER a successful publish whose local persistence failed).
      // eBay documents `offerId` as returned only by a successful createOffer —
      // the conflict error's parameters are NOT a contract — so the canonical
      // recovery is getOffers by SKU. The error parameter is kept as a fast
      // path, but a recovered offer that is ALREADY PUBLISHED short-circuits:
      // publishOffer converts an unpublished offer into a listing, so calling
      // it again would leave the live listing untracked — return its existing
      // listingId instead so the caller can repair local state.
      const recovered = await this.findOfferBySku(
        token,
        baseUrl,
        request.sku,
        marketplaceId,
        contentLanguage,
        signal,
      );
      if (recovered?.listingId) {
        const result = {
          listingId: recovered.listingId,
          offerId: recovered.offerId,
          status: "published" as const,
        };
        await complete?.(result, dispatchContext(lease));
        return result;
      }
      const existing = recovered?.offerId ?? existingOfferIdFrom(err);
      if (!existing) {
        const conflict = err as EbayApiError;
        throw new EbayWriteAmbiguousError(
          "eBay reports an existing offer, but recovery could not identify it",
          conflict.status,
          conflict.body,
        );
      }
      // Update the recovered (unpublished) offer in place so price/description
      // are current, then publish.
      offerId = existing;
      await this.call(
        token,
        "PUT",
        `${baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
        offerBody,
        contentLanguage,
        signal,
      );
    }

    // --- 3. Publish the offer -> live listing id. -----------------------------
    const published = await this.call<{ listingId?: string; listingUrl?: string }>(
      token,
      "POST",
      `${baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
      {},
      contentLanguage,
      signal,
    );
    if (!published?.listingId) {
      throw new EbayWriteAmbiguousError(
        "eBay publish returned no listingId",
        200,
        published,
      );
    }

      const result = {
        listingId: published.listingId,
        offerId,
        ...(typeof published.listingUrl === "string"
          ? { listingUrl: published.listingUrl }
          : {}),
        status: "published" as const,
      };
      await complete?.(result, dispatchContext(lease));
      return result;
    } finally {
      await lease?.release();
    }
  }

  /**
   * Revise a live listing's price (issue #102) via the documented
   * `POST /sell/inventory/v1/bulk_update_price_quantity` — eBay's endpoint for
   * updating an offer's price WITHOUT republishing (a full offer PUT requires
   * re-sending the whole offer body; this touches only the price). One SKU +
   * offer per call; the bulk shape is just what the API mandates.
   *
   * The endpoint can return HTTP 200 with PER-OFFER failures inside the
   * `responses` array, so success is asserted on the inner statusCode too —
   * a silent partial failure here would record a reprice that never reached
   * the live listing.
   */
  async revisePrice(
    request: EbayReviseRequest,
    complete?: EbayReviseCompletion,
  ): Promise<EbayReviseResult> {
    const env = this.readEnv();
    const baseUrl = env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com";
    const marketplaceId = env.EBAY_MARKETPLACE_ID ?? "EBAY_US";
    const contentLanguage = marketplaceContentLanguage(
      marketplaceId,
      env.EBAY_CONTENT_LANGUAGE,
    );

    const lease = await this.tokenProvider.beginProviderDispatch?.(
      request.sku,
      "reprice",
    );
    const signal = providerDispatchSignal(lease?.signal);
    try {
      const token = await this.tokenProvider.getAccessToken(
        lease?.accountGeneration,
        signal,
      );
      const body = {
      requests: [
        {
          sku: request.sku,
          offers: [{ offerId: request.offerId, price: request.price }],
        },
      ],
    };
    const result = await this.call<{
      responses?: Array<{
        statusCode?: number;
        offers?: Array<{ offerId?: string; statusCode?: number }>;
      }>;
    }>(
      token,
      "POST",
      `${baseUrl}/sell/inventory/v1/bulk_update_price_quantity`,
      body,
      contentLanguage,
      signal,
    );

    const inner = result?.responses?.[0];
    const offer = inner?.offers?.[0];
    const innerStatus = offer?.statusCode ?? inner?.statusCode;
    if (innerStatus == null) {
      throw new EbayWriteAmbiguousError(
        `eBay price revision for offer ${request.offerId} returned no per-offer confirmation`,
        200,
        result,
      );
    }
    if (innerStatus < 200 || innerStatus >= 300) {
      throw new EbayApiError(
        `eBay price revision for offer ${request.offerId} failed (offer status ${innerStatus})`,
        innerStatus,
        result,
      );
    }
      const revision = {
        offerId: offer?.offerId ?? request.offerId,
        status: "revised" as const,
      };
      await complete?.(revision, dispatchContext(lease));
      return revision;
    } finally {
      await lease?.release();
    }
  }

  /**
   * Recover an existing offer for a SKU via `GET /sell/inventory/v1/offer` —
   * eBay's documented way to retrieve offers after a createOffer conflict.
   * Returns the offer id PLUS, when the offer is already PUBLISHED, its live
   * listingId (getOffers exposes `status` and `listing.listingId`) — the
   * caller must NOT republish a published offer. Returns undefined (caller
   * rethrows the original conflict) when the lookup itself fails or finds
   * nothing, so recovery never masks the root error.
   */
  private async findOfferBySku(
    token: string,
    baseUrl: string,
    sku: string,
    marketplaceId: string,
    contentLanguage: string,
    signal?: AbortSignal,
  ): Promise<{ offerId: string; listingId?: string } | undefined> {
    try {
      const found = await this.call<{
        offers?: Array<{
          offerId?: string;
          marketplaceId?: string;
          status?: string;
          listing?: { listingId?: string };
        }>;
      }>(
        token,
        "GET",
        `${baseUrl}/sell/inventory/v1/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${encodeURIComponent(marketplaceId)}`,
        undefined,
        contentLanguage,
        signal,
      );
      const offers = found?.offers ?? [];
      // Prefer the offer on OUR marketplace; a SKU can carry offers on others.
      const match =
        offers.find((o) => o.marketplaceId === marketplaceId) ?? offers[0];
      if (!match?.offerId) return undefined;
      const listingId =
        match.status === "PUBLISHED" && match.listing?.listingId
          ? match.listing.listingId
          : undefined;
      return { offerId: match.offerId, listingId };
    } catch {
      return undefined;
    }
  }

  /** One authenticated Sell API call; throws EbayApiError on any non-2xx. */
  private async call<T = unknown>(
    token: string,
    method: "GET" | "PUT" | "POST",
    url: string,
    body: unknown,
    contentLanguage: string,
    signal?: AbortSignal,
  ): Promise<T | undefined> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
    };
    if (method !== "GET") {
      headers["content-type"] = "application/json";
      // Required by the Sell Inventory API on create/update calls; locale
      // must match the target marketplace (derived in publishListing).
      headers["content-language"] = contentLanguage;
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers,
        body: method === "GET" ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (cause) {
      if (method !== "GET") {
        throw new EbayWriteAmbiguousError(
          `eBay ${method} ${new URL(url).pathname} ended without an acknowledgement`,
          0,
          cause,
        );
      }
      throw cause;
    }

    let text: string;
    try {
      text = await res.text();
    } catch (cause) {
      if (method !== "GET") {
        throw new EbayWriteAmbiguousError(
          `eBay ${method} ${new URL(url).pathname} returned an unreadable acknowledgement`,
          res.status,
          cause,
        );
      }
      throw cause;
    }
    const parsed: unknown = text ? safeJsonParse(text) : undefined;

    if (!res.ok) {
      const detail = firstErrorMessage(parsed);
      if (method !== "GET" && res.status >= 500) {
        throw new EbayWriteAmbiguousError(
          `eBay ${method} ${new URL(url).pathname} returned an unconfirmed server error (HTTP ${res.status})`,
          res.status,
          parsed ?? text,
        );
      }
      throw new EbayApiError(
        `eBay ${method} ${new URL(url).pathname} failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
        res.status,
        parsed ?? text,
      );
    }
    return parsed as T | undefined;
  }
}

function dispatchContext(
  lease: Awaited<ReturnType<NonNullable<EbayTokenProvider["beginProviderDispatch"]>>> | undefined,
) {
  return lease
    ? {
        accountGeneration: lease.accountGeneration,
        connectionGeneration: lease.connectionGeneration,
        publishClaimId: lease.publishClaimId,
        attemptToken: lease.attemptToken,
      }
    : null;
}

function providerDispatchSignal(parentSignal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(PROVIDER_DISPATCH_TIMEOUT_MS);
  return parentSignal
    ? AbortSignal.any([parentSignal, timeoutSignal])
    : timeoutSignal;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function firstErrorMessage(body: unknown): string | undefined {
  return (body as EbayErrorPayload | undefined)?.errors?.[0]?.message;
}

/** Is the error eBay's "offer already exists" createOffer conflict (25002)? */
function isOfferConflict(err: unknown): boolean {
  if (!(err instanceof EbayApiError)) return false;
  const errors = (err.body as EbayErrorPayload | undefined)?.errors ?? [];
  return errors.some((e) => e.errorId === OFFER_ALREADY_EXISTS);
}

/**
 * FAST PATH only: some 25002 payloads carry the existing offerId as an error
 * parameter, but eBay does not document this as a contract — when absent, the
 * caller falls back to the documented getOffers-by-SKU lookup.
 */
function existingOfferIdFrom(err: unknown): string | undefined {
  if (!(err instanceof EbayApiError)) return undefined;
  const errors = (err.body as EbayErrorPayload | undefined)?.errors ?? [];
  for (const e of errors) {
    if (e.errorId !== OFFER_ALREADY_EXISTS) continue;
    const param = e.parameters?.find((p) => p.name === "offerId" && p.value);
    if (param?.value) return param.value;
  }
  return undefined;
}
