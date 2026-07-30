import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { identificationSchema } from "@/lib/pipeline/types";
import {
  acceptedPricingEvidenceRecordSchema,
  persistedPriceResultSchema,
} from "@/lib/pricing-evidence/snapshot";
import {
  effectivePrice as resolveEffectivePrice,
  parsePriceOverride,
} from "@/lib/pipeline/autopilot";
import { signPhotoUrlMap } from "@/lib/vision/photos";
import { ITEM_CONDITIONS } from "@/lib/items/condition";

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });
const currency = z.number().positive().multipleOf(0.01);

const rawReviewSchema = z
  .object({
    run: z
      .object({
        id: uuid,
        userId: z.string().min(1),
        itemId: uuid,
        listingId: uuid,
        status: z.literal("succeeded"),
        stage: z.literal("completed"),
      })
      .strict(),
    item: z
      .object({
        id: uuid,
        userId: z.string().min(1),
        photos: z.array(z.string().min(1)).min(1).max(5),
        identification: identificationSchema,
        condition: z.enum(ITEM_CONDITIONS),
        priceOverride: z.number().finite().nullable(),
        reviewRevision: uuid,
      })
      .strict(),
    listing: z
      .object({
        id: uuid,
        userId: z.string().min(1),
        itemId: uuid,
        runId: uuid,
        title: z.string().trim().min(1).max(80),
        description: z.string().trim().min(1),
        copy: z
          .object({
            fields: z
              .object({
                itemSpecifics: z.record(
                  z.string().trim().min(1),
                  z.string().trim().min(1),
                ),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .strict(),
    pricingSnapshot: z
      .object({
        runId: uuid,
        userId: z.string().min(1),
        itemId: uuid,
        listingId: uuid,
        schemaVersion: z.literal(1),
        priceResult: persistedPriceResultSchema,
        evidence: z
          .array(
            acceptedPricingEvidenceRecordSchema.extend({
              evidenceAsOf: isoDateTime,
            }).strict(),
          )
          .max(5),
        evidenceAsOf: isoDateTime,
      })
      .strict(),
  })
  .strict();

export const listingReviewProjectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    binding: z
      .object({
        runId: uuid,
        itemId: uuid,
        listingId: uuid,
        reviewRevision: uuid,
      })
      .strict(),
    photos: z
      .array(
        z
          .object({
            ordinal: z.number().int().min(0).max(4),
            url: z.string().url().startsWith("https://"),
          })
          .strict(),
      )
      .min(1)
      .max(5),
    identity: z
      .object({
        label: z.string().trim().min(1),
        confident: z.boolean(),
      })
      .strict(),
    listing: z
      .object({
        title: z.string().trim().min(1).max(80),
        description: z.string().trim().min(1),
        condition: z.enum(ITEM_CONDITIONS),
        specifics: z.array(
          z
            .object({
              name: z.string().trim().min(1),
              value: z.string().trim().min(1),
            })
            .strict(),
        ),
      })
      .strict(),
    pricing: z
      .object({
        suggestedPrice: currency,
        range: z
          .object({
            minimum: currency,
            maximum: currency,
          })
          .strict(),
        confidence: z.number().min(0).max(1),
        sellerPriceOverride: currency.nullable(),
        effectivePrice: currency,
      })
      .strict(),
    evidenceAsOf: isoDateTime,
    verifiedSoldMatches: z
      .array(
        z
          .object({
            id: z.string().min(1).max(2_048),
            sourceURL: z.string().url().startsWith("https://"),
            title: z.string().min(1).max(500).nullable(),
            soldPrice: currency,
            currency: z.string().regex(/^[A-Z]{3}$/),
            condition: z.string().min(1).max(120).nullable(),
            soldAt: z.number().int().nonnegative().nullable(),
          })
          .strict(),
      )
      .max(5),
    startingPriceCopy: z.literal("Starting price estimate"),
    soldEvidenceCopy: z.literal("No verified sold matches found.").nullable(),
  })
  .strict();

export type ListingReviewProjection = z.infer<
  typeof listingReviewProjectionSchema
>;

export interface ListingReviewReader {
  forRun(input: {
    userId: string;
    bearerToken: string;
    runId: string;
    mintOperationToken?: () => Promise<string>;
  }): Promise<ListingReviewProjection | null>;
}

interface ListingReviewDataError {
  message: string;
}

export interface ListingReviewDataClient {
  readReview(runId: string, bearerToken: string): PromiseLike<{
    data: unknown;
    error: ListingReviewDataError | null;
  }>;
  signPhotoUrls(
    paths: string[],
    bearerToken: string,
  ): Promise<
    Array<{
      ordinal: number;
      path: string;
      signedUrl: string;
    }>
  >;
}

export class ListingReviewProjectionError extends Error {}

function usablePriceOverride(raw: number | null): number | null {
  try {
    return parsePriceOverride(raw);
  } catch {
    return null;
  }
}

function projectReview(
  parsed: z.infer<typeof rawReviewSchema>,
  signedPhotos: Awaited<
    ReturnType<ListingReviewDataClient["signPhotoUrls"]>
  >,
  input: { userId: string; runId: string },
): ListingReviewProjection {
  const { run, item, listing, pricingSnapshot } = parsed;
  if (
    run.id !== input.runId
    || run.userId !== input.userId
    || item.userId !== input.userId
    || listing.userId !== input.userId
    || pricingSnapshot.userId !== input.userId
    || run.itemId !== item.id
    || run.itemId !== listing.itemId
    || run.itemId !== pricingSnapshot.itemId
    || run.listingId !== listing.id
    || run.listingId !== pricingSnapshot.listingId
    || listing.runId !== pricingSnapshot.runId
  ) {
    throw new ListingReviewProjectionError(
      "Listing Review result crossed a tenant or durable-result boundary.",
    );
  }
  if (
    signedPhotos.length !== item.photos.length
    || signedPhotos.some(
      (photo, ordinal) =>
        photo.ordinal !== ordinal || photo.path !== item.photos[ordinal],
    )
  ) {
    throw new ListingReviewProjectionError(
      "Listing Review photos are incomplete or out of order.",
    );
  }
  const sourceURLs = new Set(
    pricingSnapshot.priceResult.sources.map((source) => source.url),
  );
  if (
    pricingSnapshot.evidence.some(
      (record) =>
        record.evidenceAsOf !== pricingSnapshot.evidenceAsOf
        || !sourceURLs.has(record.sourceUrl),
    )
  ) {
    throw new ListingReviewProjectionError(
      "Listing Review evidence timestamps or citations are incoherent.",
    );
  }

  const suggestedPrice = pricingSnapshot.priceResult.suggested;
  const sellerPriceOverride = usablePriceOverride(item.priceOverride);
  const effectivePrice = resolveEffectivePrice(
    suggestedPrice,
    sellerPriceOverride,
  );
  if (effectivePrice == null) {
    throw new ListingReviewProjectionError(
      "Listing Review has no usable effective price.",
    );
  }
  const verifiedSoldMatches = pricingSnapshot.evidence.map((record) => ({
    id: record.id,
    sourceURL: record.sourceUrl,
    title: record.title ?? null,
    soldPrice: record.price,
    currency: record.currency,
    condition: record.condition ?? null,
    soldAt: record.soldAt ?? null,
  }));

  return listingReviewProjectionSchema.parse({
    schemaVersion: 1,
    binding: {
      runId: run.id,
      itemId: item.id,
      listingId: listing.id,
      reviewRevision: item.reviewRevision,
    },
    photos: signedPhotos.map(({ ordinal, signedUrl }) => ({
      ordinal,
      url: signedUrl,
    })),
    identity: {
      label: item.identification.label,
      confident: item.identification.confident,
    },
    listing: {
      title: listing.title,
      description: listing.description,
      condition: item.condition,
      specifics: Object.entries(listing.copy.fields.itemSpecifics)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => ({ name, value })),
    },
    pricing: {
      suggestedPrice,
      range: {
        minimum: pricingSnapshot.priceResult.range.min,
        maximum: pricingSnapshot.priceResult.range.max,
      },
      confidence: pricingSnapshot.priceResult.confidence,
      sellerPriceOverride,
      effectivePrice,
    },
    evidenceAsOf: pricingSnapshot.evidenceAsOf,
    verifiedSoldMatches,
    startingPriceCopy: "Starting price estimate",
    soldEvidenceCopy:
      verifiedSoldMatches.length === 0
        ? "No verified sold matches found."
        : null,
  });
}

export function createListingReviewReader(
  dataClient: ListingReviewDataClient,
): ListingReviewReader {
  return {
    async forRun(input) {
      const readToken = input.mintOperationToken
        ? await input.mintOperationToken()
        : input.bearerToken;
      const result = await dataClient.readReview(
        input.runId,
        readToken,
      );
      if (result.error) {
        throw new ListingReviewProjectionError(
          "Listing Review read failed.",
        );
      }
      if (result.data == null) return null;
      const raw = rawReviewSchema.safeParse(result.data);
      if (!raw.success) {
        throw new ListingReviewProjectionError(
          "Listing Review result is malformed.",
        );
      }
      const photoToken = input.mintOperationToken
        ? await input.mintOperationToken()
        : input.bearerToken;
      const signedPhotos = await dataClient.signPhotoUrls(
        raw.data.item.photos,
        photoToken,
      );
      return projectReview(raw.data, signedPhotos, input);
    },
  };
}

function supabaseClient(
  input: {
    publishableKey: string;
    supabaseURL: string;
  },
  bearerToken: string,
): SupabaseClient {
  return createClient(input.supabaseURL, input.publishableKey, {
    accessToken: async () => bearerToken,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createConfiguredSupabaseListingReviewReader(input: {
  publishableKey: string;
  supabaseURL: string;
}): ListingReviewReader {
  if (!input.publishableKey.startsWith("sb_publishable_")) {
    throw new Error(
      "Listing Review requires a current Supabase publishable key.",
    );
  }
  return createListingReviewReader({
    async readReview(runId, bearerToken) {
      return supabaseClient(input, bearerToken).rpc(
        "get_mobile_listing_review",
        {
          p_run_id: runId,
        },
      );
    },
    async signPhotoUrls(paths, bearerToken) {
      const signed = await signPhotoUrlMap(
        supabaseClient(input, bearerToken),
        paths,
      );
      return paths.flatMap((path, ordinal) => {
        const signedUrl = signed.get(path);
        return signedUrl ? [{ ordinal, path, signedUrl }] : [];
      });
    },
  });
}
