import type {
  EbayAdapter,
  EbayPublishRequest,
  EbayPublishResult,
  EbayTokenProvider,
} from "./types";
import { EbayApiError } from "./types";
import { EnvTokenProvider } from "./auth";

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
          ...(request.imageUrls.length > 0 ? { imageUrls: request.imageUrls } : {}),
        },
        availability: {
          shipToLocationAvailability: { quantity: request.quantity },
        },
      },
    );

    // --- 2. Create (or recover + update) the offer. ---------------------------
    const offerBody = {
      sku: request.sku,
      marketplaceId,
      format: "FIXED_PRICE",
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
      );
      if (!created?.offerId) {
        throw new EbayApiError("eBay offer create returned no offerId", 200, created);
      }
      offerId = created.offerId;
    } catch (err) {
      const existing = existingOfferIdFrom(err);
      if (!existing) throw err;
      // Offer already exists for this SKU (e.g. an earlier publish failed after
      // step 2). Update it in place so price/description are current, then publish.
      offerId = existing;
      await this.call(
        token,
        "PUT",
        `${baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}`,
        offerBody,
      );
    }

    // --- 3. Publish the offer -> live listing id. -----------------------------
    const published = await this.call<{ listingId?: string }>(
      token,
      "POST",
      `${baseUrl}/sell/inventory/v1/offer/${encodeURIComponent(offerId)}/publish`,
      {},
    );
    if (!published?.listingId) {
      throw new EbayApiError("eBay publish returned no listingId", 200, published);
    }

    return { listingId: published.listingId, offerId, status: "published" };
  }

  /** One authenticated Sell API call; throws EbayApiError on any non-2xx. */
  private async call<T = unknown>(
    token: string,
    method: "PUT" | "POST",
    url: string,
    body: unknown,
  ): Promise<T | undefined> {
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        // Required by the Sell Inventory API on create/update calls.
        "content-language": "en-US",
        accept: "application/json",
      },
      body: JSON.stringify(body),
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

/**
 * If the error is eBay's "offer already exists" (25002), pull the existing
 * offerId out of the error parameters so the caller can recover instead of
 * failing a re-publish.
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
