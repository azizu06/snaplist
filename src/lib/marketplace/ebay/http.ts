import type {
  EbayAdapter,
  EbayPublishRequest,
  EbayPublishResult,
  EbayReviseRequest,
  EbayReviseResult,
  EbayTokenProvider,
} from "./types";
import { EbayApiError } from "./types";
import { EnvTokenProvider } from "./auth";
import { marketplaceContentLanguage } from "./map";

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
}

/** eBay's "offer entity already exists" error id (create-offer conflict). */
const OFFER_ALREADY_EXISTS = 25002;

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

  constructor(options: HttpEbayAdapterOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.readEnv = options.env ?? (() => process.env);
    this.tokenProvider =
      options.tokenProvider ??
      new EnvTokenProvider({ fetch: options.fetch, env: options.env });
  }

  async publishListing(request: EbayPublishRequest): Promise<EbayPublishResult> {
    const env = this.readEnv();
    const baseUrl = env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com";
    const marketplaceId = env.EBAY_MARKETPLACE_ID ?? "EBAY_US";
    // The Sell Inventory API requires Content-Language on create/update calls
    // and documents marketplace-specific locales — en-US against EBAY_DE can
    // reject the publish, so the locale must follow the marketplace flip.
    const contentLanguage = marketplaceContentLanguage(
      marketplaceId,
      env.EBAY_CONTENT_LANGUAGE,
    );

    // Fail fast, readably, on missing seller config (sandbox business policies).
    const missing = [
      "EBAY_FULFILLMENT_POLICY_ID",
      "EBAY_PAYMENT_POLICY_ID",
      "EBAY_RETURN_POLICY_ID",
      "EBAY_MERCHANT_LOCATION_KEY",
    ].filter((k) => !env[k]);
    if (missing.length > 0) {
      throw new Error(
        `eBay seller configuration missing: ${missing.join(", ")}. ` +
          "Create business policies + an inventory location on the sandbox seller " +
          "account and set these env vars (see docs/ebay-sandbox.md).",
      );
    }

    // eBay requires at least one image to publish a listing. Fail fast LOCALLY
    // — before the token mint and before any Sell API write — so a doomed
    // publish never leaves partial remote state (inventory item / offer).
    if (request.imageUrls.length === 0) {
      throw new Error(
        `Cannot publish listing ${request.sku} to eBay: no image URLs were provided. ` +
          "eBay requires at least one photo. Add or re-upload the item's photos and retry.",
      );
    }

    const token = await this.tokenProvider.getAccessToken();

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
        fulfillmentPolicyId: env.EBAY_FULFILLMENT_POLICY_ID,
        paymentPolicyId: env.EBAY_PAYMENT_POLICY_ID,
        returnPolicyId: env.EBAY_RETURN_POLICY_ID,
      },
      pricingSummary: { price: request.price },
      merchantLocationKey: env.EBAY_MERCHANT_LOCATION_KEY,
    };

    let offerId: string;
    try {
      const created = await this.call<{ offerId?: string }>(
        token,
        "POST",
        `${baseUrl}/sell/inventory/v1/offer`,
        offerBody,
        contentLanguage,
      );
      if (!created?.offerId) {
        throw new EbayApiError("eBay offer create returned no offerId", 200, created);
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
      );
      if (recovered?.listingId) {
        return {
          listingId: recovered.listingId,
          offerId: recovered.offerId,
          status: "published",
        };
      }
      const existing = recovered?.offerId ?? existingOfferIdFrom(err);
      if (!existing) throw err;
      // Update the recovered (unpublished) offer in place so price/description
      // are current, then publish.
      offerId = existing;
      await this.call(
        token,
        "PUT",
        `${baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
        offerBody,
        contentLanguage,
      );
    }

    // --- 3. Publish the offer -> live listing id. -----------------------------
    const published = await this.call<{ listingId?: string }>(
      token,
      "POST",
      `${baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
      {},
      contentLanguage,
    );
    if (!published?.listingId) {
      throw new EbayApiError("eBay publish returned no listingId", 200, published);
    }

    return { listingId: published.listingId, offerId, status: "published" };
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
  async revisePrice(request: EbayReviseRequest): Promise<EbayReviseResult> {
    const env = this.readEnv();
    const baseUrl = env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com";
    const marketplaceId = env.EBAY_MARKETPLACE_ID ?? "EBAY_US";
    const contentLanguage = marketplaceContentLanguage(
      marketplaceId,
      env.EBAY_CONTENT_LANGUAGE,
    );

    const token = await this.tokenProvider.getAccessToken();
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
    );

    const inner = result?.responses?.[0];
    const offer = inner?.offers?.[0];
    const innerStatus = offer?.statusCode ?? inner?.statusCode;
    if (innerStatus != null && (innerStatus < 200 || innerStatus >= 300)) {
      throw new EbayApiError(
        `eBay price revision for offer ${request.offerId} failed (offer status ${innerStatus})`,
        innerStatus,
        result,
      );
    }
    return { offerId: offer?.offerId ?? request.offerId, status: "revised" };
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
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    const parsed: unknown = text ? safeJsonParse(text) : undefined;

    if (!res.ok) {
      const detail = firstErrorMessage(parsed);
      throw new EbayApiError(
        `eBay ${method} ${new URL(url).pathname} failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`,
        res.status,
        parsed ?? text,
      );
    }
    return parsed as T | undefined;
  }
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
