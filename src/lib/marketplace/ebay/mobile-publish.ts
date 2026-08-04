import type { SupabaseClient } from "@supabase/supabase-js";
import type { EbayAdapter } from "./types";
import {
  publishListingToEbayAndNotify,
  type PublishOutcome,
} from "./publish";

export interface MobileEbayPublishStatus {
  listingId: string;
  outcome: "published";
  ebayListingId: string;
  ebayOfferId: string | null;
  alreadyPublished: boolean;
}

export interface MobileEbayPublishGateway {
  publish(input: {
    userId: string;
    bearerToken: string;
    listingId: string;
    expectedReviewRevision: string;
    idempotencyKey: string;
  }): Promise<MobileEbayPublishStatus>;
}

export function createMobileEbayPublishService(input: {
  clientForBearer: (bearerToken: string) => SupabaseClient;
  completionClientForBearer: (bearerToken: string) => SupabaseClient;
  adapterFor: (
    client: SupabaseClient,
    completionClient: SupabaseClient,
    userId: string,
  ) => Promise<EbayAdapter>;
  env?: () => Record<string, string | undefined>;
}): MobileEbayPublishGateway {
  return {
    async publish(operation) {
      const env = input.env?.() ?? process.env;
      assertSandboxOnly(env.EBAY_BASE_URL);
      const client = input.clientForBearer(operation.bearerToken);
      const completionClient = input.completionClientForBearer(
        operation.bearerToken,
      );
      const outcome = await publishListingToEbayAndNotify(
        client,
        operation.userId,
        operation.listingId,
        await input.adapterFor(client, completionClient, operation.userId),
        {
          completionClient,
          env: () => env,
          expectedReviewRevision: operation.expectedReviewRevision,
        },
      );
      return mobilePublishStatus(outcome);
    },
  };
}

function mobilePublishStatus(outcome: PublishOutcome): MobileEbayPublishStatus {
  return {
    listingId: outcome.listingId,
    outcome: "published",
    ebayListingId: outcome.ebayListingId,
    ebayOfferId: outcome.ebayOfferId,
    alreadyPublished: outcome.alreadyPublished,
  };
}

function assertSandboxOnly(baseUrl: string | undefined): void {
  const configured = baseUrl ?? "https://api.sandbox.ebay.com";
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("The mobile eBay adapter is not configured for Sandbox.");
  }
  if (
    parsed.origin !== "https://api.sandbox.ebay.com"
    || (parsed.pathname !== "" && parsed.pathname !== "/")
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("The mobile eBay adapter is restricted to Sandbox.");
  }
}
