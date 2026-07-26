import { z } from "zod";
import { marketplaceContentLanguage } from "./map";
import type { EbayTokenProvider } from "./types";
import { EbayApiError } from "./types";
import type {
  EbayPolicyLocationCandidate,
  EbayPolicyLocationCandidates,
  EbayPolicyLocationDiscoveryAdapter,
} from "./policy-location-discovery";

type Env = Record<string, string | undefined>;

const categoryTypeSchema = z
  .object({
    name: z.string(),
    default: z.boolean().optional(),
  })
  .strip();

const policySchema = z
  .object({
    name: z.string().optional(),
    marketplaceId: z.string(),
    categoryTypes: z.array(categoryTypeSchema),
  })
  .loose();

const fulfillmentResponseSchema = z.object({
  fulfillmentPolicies: z.array(
    policySchema.extend({ fulfillmentPolicyId: z.string().min(1) }),
  ),
});

const paymentResponseSchema = z.object({
  paymentPolicies: z.array(
    policySchema.extend({ paymentPolicyId: z.string().min(1) }),
  ),
});

const returnResponseSchema = z.object({
  returnPolicies: z.array(
    policySchema.extend({ returnPolicyId: z.string().min(1) }),
  ),
});

const locationResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  locations: z.array(
    z
      .object({
        merchantLocationKey: z.string().min(1),
        merchantLocationStatus: z.enum(["ENABLED", "DISABLED"]),
        name: z.string().optional(),
      })
      .loose(),
  ),
});

export interface HttpEbayPolicyLocationDiscoveryAdapterOptions {
  tokenProvider: EbayTokenProvider;
  fetch?: typeof fetch;
  env?: () => Env;
}

const DISCOVERY_TIMEOUT_MS = 30_000;
const LOCATION_PAGE_LIMIT = 100;
const MAX_LOCATION_PAGES = 100;

export class HttpEbayPolicyLocationDiscoveryAdapter
  implements EbayPolicyLocationDiscoveryAdapter
{
  private readonly tokenProvider: EbayTokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly readEnv: () => Env;

  constructor(options: HttpEbayPolicyLocationDiscoveryAdapterOptions) {
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.readEnv = options.env ?? (() => process.env);
  }

  async readCandidates(input: {
    marketplaceId: string;
    accountGeneration: string;
  }): Promise<EbayPolicyLocationCandidates> {
    const env = this.readEnv();
    const baseUrl = env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com";
    const contentLanguage = marketplaceContentLanguage(
      input.marketplaceId,
      env.EBAY_CONTENT_LANGUAGE,
    );
    const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
    const token = await this.tokenProvider.getAccessToken(
      input.accountGeneration,
      signal,
    );
    const query = `marketplace_id=${encodeURIComponent(input.marketplaceId)}`;
    const headers = {
      authorization: `Bearer ${token}`,
      "content-language": contentLanguage,
    };

    const [fulfillment, payment, returns, locations] = await Promise.all([
      this.getJson(
        `${baseUrl}/sell/account/v1/fulfillment_policy?${query}`,
        headers,
        signal,
      ).then((body) => fulfillmentResponseSchema.parse(body)),
      this.getJson(
        `${baseUrl}/sell/account/v1/payment_policy?${query}`,
        headers,
        signal,
      ).then((body) => paymentResponseSchema.parse(body)),
      this.getJson(
        `${baseUrl}/sell/account/v1/return_policy?${query}`,
        headers,
        signal,
      ).then((body) => returnResponseSchema.parse(body)),
      this.getInventoryLocations(baseUrl, token, signal),
    ]);

    return {
      fulfillmentPolicies: usablePolicies(
        fulfillment.fulfillmentPolicies,
        "fulfillmentPolicyId",
        input.marketplaceId,
        "Fulfillment policy",
      ),
      paymentPolicies: usablePolicies(
        payment.paymentPolicies,
        "paymentPolicyId",
        input.marketplaceId,
        "Payment policy",
      ),
      returnPolicies: usablePolicies(
        returns.returnPolicies,
        "returnPolicyId",
        input.marketplaceId,
        "Return policy",
      ),
      inventoryLocations: locations
        .filter((location) => location.merchantLocationStatus === "ENABLED")
        .map((location, index) => ({
          id: location.merchantLocationKey,
          label: displayLabel(location.name, "Inventory location", index),
          providerDefault: false,
        })),
    };
  }

  private async getInventoryLocations(
    baseUrl: string,
    token: string,
    signal: AbortSignal,
  ): Promise<z.infer<typeof locationResponseSchema>["locations"]> {
    const locations: z.infer<typeof locationResponseSchema>["locations"] = [];
    for (let page = 0; page < MAX_LOCATION_PAGES; page += 1) {
      const body = await this.getJson(
        `${baseUrl}/sell/inventory/v1/location?limit=${LOCATION_PAGE_LIMIT}&offset=${locations.length}`,
        { authorization: `Bearer ${token}` },
        signal,
      );
      const response = locationResponseSchema.parse(body);
      locations.push(...response.locations);
      if (locations.length >= response.total) return locations;
      if (response.locations.length === 0) {
        throw new Error("eBay inventory-location pagination made no progress.");
      }
    }
    throw new Error("eBay inventory-location pagination exceeded its safe limit.");
  }

  private async getJson(
    url: string,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers,
      signal,
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new EbayApiError(
        `eBay GET ${new URL(url).pathname} failed (HTTP ${response.status})`,
        response.status,
        body,
      );
    }
    return body;
  }
}

function usablePolicies<
  IdKey extends "fulfillmentPolicyId" | "paymentPolicyId" | "returnPolicyId",
>(
  policies: Array<
    z.infer<typeof policySchema> & Record<IdKey, string>
  >,
  idKey: IdKey,
  marketplaceId: string,
  fallbackLabel: string,
): EbayPolicyLocationCandidate[] {
  return policies
    .filter(
      (policy) =>
        policy.marketplaceId === marketplaceId
        && policy.categoryTypes.some(
          (category) => category.name === "ALL_EXCLUDING_MOTORS_VEHICLES",
        ),
    )
    .map((policy, index) => ({
      id: policy[idKey],
      label: displayLabel(policy.name, fallbackLabel, index),
      // eBay still returns categoryTypes.default on some reads, but its current
      // Account API docs mark the field deprecated and explicitly non-authoritative.
      providerDefault: false,
    }));
}

function displayLabel(
  value: string | undefined,
  fallback: string,
  index: number,
): string {
  const safe = value
    ?.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return safe || `${fallback} ${index + 1}`;
}
