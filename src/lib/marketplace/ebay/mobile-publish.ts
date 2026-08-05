import type { SupabaseClient } from "@supabase/supabase-js";
import type { EbayAdapter } from "./types";
import { effectivePrice } from "@/lib/pipeline";
import { loadReviewSnapshot } from "@/lib/pipeline/review-snapshot";
import { toEbayAspects, toEbayCondition } from "./map";
import { PublishValidationError } from "./errors";
import {
  deleteEbayConnection,
  getEbayConnectionStatus,
  type EbayConnectionStatus,
} from "./connections";
import {
  PublishedReplayConflictError,
  publishListingToEbayAndNotify,
  type PublishOutcome,
} from "./publish";
import { assertMobileEbayOperatorActivation } from "./mobile-operator-activation";

export interface MobileEbayPublishStatus {
  listingId: string;
  outcome:
    | "not_published"
    | "outcome_not_yet_known"
    | "failed"
    | "published";
  ebayListingId: string | null;
  ebayOfferId: string | null;
  alreadyPublished: boolean;
  listingUrl: string | null;
  ebayEnvironment: "sandbox" | "production";
}

export interface MobileEbayPublishGateway {
  connection(input: {
    userId: string;
    bearerToken: string;
  }): Promise<EbayConnectionStatus>;
  disconnect(input: {
    userId: string;
    bearerToken: string;
  }): Promise<EbayConnectionStatus>;
  preflight(input: {
    userId: string;
    bearerToken: string;
    listingId: string;
  }): Promise<MobileEbayPublishPreflight>;
  status(input: {
    userId: string;
    bearerToken: string;
    listingId: string;
  }): Promise<MobileEbayPublishStatus>;
  publish(input: {
    userId: string;
    bearerToken: string;
    listingId: string;
    expectedReviewRevision: string;
    idempotencyKey: string;
  }): Promise<MobileEbayPublishStatus>;
}

export interface MobileEbayPublishPreflight {
  listingId: string;
  title: string;
  description: string;
  effectivePrice: { amount: number; label: "What will be listed" };
  photoCount: number;
  marketplace: string;
  ebayCondition: ReturnType<typeof toEbayCondition>;
  itemSpecifics: Record<string, string[]>;
  reviewRevision: string;
  connection: EbayConnectionStatus;
  publishEligibility: {
    enabled: boolean | null;
    eligible: boolean | null;
  };
}

export class MobileEbayListingNotFoundError extends Error {}

export function createMobileEbayPublishService(input: {
  clientForBearer: (bearerToken: string) => SupabaseClient;
  completionClientForBearer: (bearerToken: string) => SupabaseClient;
  adapterFor: (
    client: SupabaseClient,
    completionClient: SupabaseClient,
    userId: string,
    env: Record<string, string | undefined>,
  ) => Promise<EbayAdapter>;
  env?: () => Record<string, string | undefined>;
}): MobileEbayPublishGateway {
  return {
    async connection(operation) {
      return getEbayConnectionStatus(
        input.clientForBearer(operation.bearerToken),
      );
    },
    async disconnect(operation) {
      await deleteEbayConnection(
        input.completionClientForBearer(operation.bearerToken),
      );
      return getEbayConnectionStatus(
        input.clientForBearer(operation.bearerToken),
      );
    },
    async preflight(operation) {
      const client = input.clientForBearer(operation.bearerToken);
      const listingResult = await client
        .from("listings")
        .select("id,item_id,platform")
        .eq("id", operation.listingId)
        .maybeSingle();
      if (listingResult.error) {
        throw new Error(`Failed to load eBay preflight: ${listingResult.error.message}`);
      }
      const listing = listingResult.data as {
        id: string;
        item_id: string;
        platform: string;
      } | null;
      if (!listing || listing.platform !== "ebay") {
        throw new MobileEbayListingNotFoundError();
      }
      const [snapshot, connection] = await Promise.all([
        loadReviewSnapshot(client, listing.item_id),
        getEbayConnectionStatus(client),
      ]);
      if (
        !snapshot
        || snapshot.listing?.id !== listing.id
        || snapshot.listing.platform !== "ebay"
      ) {
        throw new MobileEbayListingNotFoundError();
      }
      const { item, prediction } = snapshot;
      const price = effectivePrice(prediction?.price, item.price_override);
      if (price == null) {
        throw new PublishValidationError(
          "This listing has no usable price. Set a price before publishing.",
        );
      }
      if (!snapshot.listing.title?.trim()) {
        throw new PublishValidationError(
          "This listing needs a title before publishing.",
        );
      }
      return {
        listingId: listing.id,
        title: snapshot.listing.title,
        description: snapshot.listing.description ?? "",
        effectivePrice: { amount: price, label: "What will be listed" },
        photoCount: Array.isArray(item.photos) ? item.photos.length : 0,
        marketplace: (input.env?.() ?? process.env).EBAY_MARKETPLACE_ID ?? "EBAY_US",
        ebayCondition: toEbayCondition(item.condition),
        itemSpecifics: toEbayAspects(
          snapshot.listing.copy && typeof snapshot.listing.copy === "object"
            ? snapshot.listing.copy as Record<string, unknown>
            : {},
        ),
        reviewRevision: item.review_revision,
        connection,
        publishEligibility: {
          enabled: prediction?.autopilot_enabled ?? null,
          eligible: prediction?.autopilot_eligible ?? null,
        },
      };
    },
    async status(operation) {
      const environment = ebayEnvironment(input.env?.() ?? process.env);
      return readMobilePublishStatus(
        input.clientForBearer(operation.bearerToken),
        operation.listingId,
        environment,
      );
    },
    async publish(operation) {
      const configuredEnv = input.env?.() ?? process.env;
      const env = {
        ...configuredEnv,
        EBAY_BASE_URL: assertMobileEbayOperatorActivation(configuredEnv),
      };
      const client = input.clientForBearer(operation.bearerToken);
      const currentStatus = await readMobilePublishStatus(
        client,
        operation.listingId,
        ebayEnvironment(env),
      );
      if (currentStatus.outcome === "published") {
        const connection = await getEbayConnectionStatus(client);
        if (!connection.connected) {
          throw new PublishedReplayConflictError(
            "This published listing remains outside SnapList control after its eBay connection changed.",
          );
        }
      }
      const completionClient = input.completionClientForBearer(
        operation.bearerToken,
      );
      const outcome = await publishListingToEbayAndNotify(
        client,
        operation.userId,
        operation.listingId,
        await input.adapterFor(
          client,
          completionClient,
          operation.userId,
          env,
        ),
        {
          completionClient,
          env: () => env,
          expectedReviewRevision: operation.expectedReviewRevision,
          idempotencyKey: operation.idempotencyKey,
        },
      );
      return mobilePublishStatus(outcome, ebayEnvironment(env));
    },
  };
}

async function readMobilePublishStatus(
  client: SupabaseClient,
  listingId: string,
  environment: "sandbox" | "production",
): Promise<MobileEbayPublishStatus> {
  const result = await client
    .from("listings")
    .select("id,platform,ebay_listing_id,ebay_offer_id,ebay_status")
    .eq("id", listingId)
    .maybeSingle();
  if (result.error) {
    throw new Error(`Failed to read eBay publish status: ${result.error.message}`);
  }
  const listing = result.data as {
    id: string;
    platform: string;
    ebay_listing_id: string | null;
    ebay_offer_id: string | null;
    ebay_status: string | null;
  } | null;
  if (!listing || listing.platform !== "ebay") {
    throw new MobileEbayListingNotFoundError();
  }
  const published =
    listing.ebay_status === "published"
    && typeof listing.ebay_listing_id === "string";
  return {
    listingId: listing.id,
    outcome: published
      ? "published"
      : listing.ebay_status === "publishing"
        ? "outcome_not_yet_known"
        : listing.ebay_status === "failed"
          ? "failed"
          : "not_published",
    ebayListingId: published ? listing.ebay_listing_id : null,
    ebayOfferId: published ? listing.ebay_offer_id : null,
    alreadyPublished: published,
    listingUrl: null,
    ebayEnvironment: environment,
  };
}

function mobilePublishStatus(
  outcome: PublishOutcome,
  environment: "sandbox" | "production",
): MobileEbayPublishStatus {
  return {
    listingId: outcome.listingId,
    outcome: "published",
    ebayListingId: outcome.ebayListingId,
    ebayOfferId: outcome.ebayOfferId,
    alreadyPublished: outcome.alreadyPublished,
    listingUrl: outcome.listingUrl,
    ebayEnvironment: environment,
  };
}

function ebayEnvironment(
  env: Record<string, string | undefined>,
): "sandbox" | "production" {
  try {
    return new URL(
      env.EBAY_BASE_URL ?? "https://api.sandbox.ebay.com",
    ).hostname.toLowerCase() === "api.ebay.com"
      ? "production"
      : "sandbox";
  } catch {
    return "sandbox";
  }
}
