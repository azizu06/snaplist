import { z } from "zod";
import { homeProjectionSchema } from "@/lib/home/projection";
import { pipelineConsumerSummarySchema } from "./worker-summary";
import { guestClaimTerminalOutcomeSchema } from "@/lib/guest-recovery/service";
import { includedOfferOutcomeSchema } from "@/lib/included-offer-fence/contract";
import { pricingEvidenceProjectionSchema } from "@/lib/pricing-evidence";
import { listingReviewProjectionSchema } from "@/lib/listing-review";
import { listingReviewSaveReceiptSchema } from "@/lib/listing-review/save";
import { guidedCorrectionReceiptSchema } from "./guided-correction";
import { ASSISTED_EXPORT_PLATFORMS } from "@/lib/export/handoff";

export const MOBILE_API_VERSION = "v1" as const;

export const apiErrorCodeSchema = z.enum([
  "unauthorized",
  "forbidden",
  "invalid_request",
  "not_found",
  "method_not_allowed",
  "conflict",
  "rate_limited",
  "internal_error",
]);

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: apiErrorCodeSchema,
        message: z.string().min(1),
        requestId: z.string().min(1),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

export const apiMetaSchema = z
  .object({ requestId: z.string().min(1) })
  .strict();

export const healthEnvelopeSchema = z
  .object({
    data: z
      .object({
        apiVersion: z.literal(MOBILE_API_VERSION),
        status: z.literal("ok"),
      })
      .strict(),
    meta: apiMetaSchema,
  })
  .strict();

export const sessionEnvelopeSchema = z
  .object({
    data: z.object({ userId: z.string().min(1) }).strict(),
    meta: apiMetaSchema,
  })
  .strict();

export const activationGuidanceEnvelopeSchema = z
  .object({
    data: z.object({ completed: z.boolean() }).strict(),
    meta: apiMetaSchema,
  })
  .strict();

/**
 * A push registration as the client may state it (#890).
 *
 * No user id, and strict: the seller's identity comes from the verified bearer,
 * so a body carrying a tenant is refused outright rather than quietly dropped.
 * A client that sent one believed it was choosing the owner, and answering 200
 * to that would be agreeing. The token shape mirrors the column's own check
 * constraint, so a malformed registration is a client error here instead of an
 * unavailable service after the database rejects it.
 */
export const deviceTokenRegistrationSchema = z
  .object({
    /**
     * Which APNs host this token is reachable on (#891). Required, and never
     * inferred: it is fixed by the `aps-environment` entitlement of the build
     * that produced the token, so a development build and the App Store build
     * on one handset are two addresses on two hosts. A default either way would
     * be wrong for half the builds, and wrong here is a push that Apple accepts
     * and drops.
     */
    apnsEnvironment: z.enum(["sandbox", "production"]),
    platform: z.literal("ios"),
    token: z.string().regex(/^[0-9a-f]{64,512}$/),
  })
  .strict();

export type DeviceTokenRegistration = z.infer<
  typeof deviceTokenRegistrationSchema
>;

export const deviceTokenEnvelopeSchema = z
  .object({
    data: z.object({ registered: z.boolean() }).strict(),
    meta: apiMetaSchema,
  })
  .strict();

export const ebayOauthSessionSchema = z
  .object({
    sessionId: z.string().uuid(),
    authorizationUrl: z.string().url(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type EbayOauthSession = z.infer<typeof ebayOauthSessionSchema>;

export const ebayOauthSessionEnvelopeSchema = z
  .object({ data: ebayOauthSessionSchema, meta: apiMetaSchema })
  .strict();

export const ebayPublishConfirmationSchema = z
  .object({
    confirmation: z.literal("publish_to_ebay"),
    expectedReviewRevision: z.string().uuid(),
  })
  .strict();

export const ebayPublishStatusSchema = z
  .object({
    listingId: z.string().uuid(),
    outcome: z.enum([
      "not_published",
      "outcome_not_yet_known",
      "failed",
      "published",
    ]),
    ebayListingId: z.string().min(1).nullable(),
    ebayOfferId: z.string().min(1).nullable(),
    alreadyPublished: z.boolean(),
    listingUrl: z.string().url().nullable(),
    ebayEnvironment: z.enum(["sandbox", "production"]).nullable(),
  })
  .strict();

export const ebayPublishStatusEnvelopeSchema = z
  .object({ data: ebayPublishStatusSchema, meta: apiMetaSchema })
  .strict();

export const ebayConnectionStatusSchema = z
  .object({
    connected: z.boolean(),
    ebayUsername: z.string().min(1).nullable(),
  })
  .strict();

export const ebayPolicySetupFamilySchema = z.enum([
  "fulfillmentPolicy",
  "paymentPolicy",
  "returnPolicy",
  "inventoryLocation",
]);

/**
 * What Settings may say about the seller's eBay business policies before they
 * try to publish (issue #694). This is a projection of the binding publish
 * already stored for this tenant, never a fresh eBay Account API read.
 */
export const ebayPolicySetupHintSchema = z
  .object({
    state: z.enum([
      "ready",
      "setupRequired",
      "selectionRequired",
      "notChecked",
    ]),
    marketplaceId: z.string().min(1).max(64),
    missing: z.array(ebayPolicySetupFamilySchema),
    ambiguous: z.array(ebayPolicySetupFamilySchema),
    message: z.string().min(1).nullable(),
    helpUrl: z.string().url().nullable(),
  })
  .strict();

export const ebayConnectionSettingsSchema = ebayConnectionStatusSchema
  .extend({ policySetup: ebayPolicySetupHintSchema.nullable() })
  .strict();

export const ebayPublishPreflightSchema = z
  .object({
    listingId: z.string().uuid(),
    title: z.string().min(1).max(80),
    description: z.string(),
    effectivePrice: z
      .object({
        amount: z.number().positive().multipleOf(0.01),
        label: z.literal("What will be listed"),
      })
      .strict(),
    photoCount: z.number().int().min(0).max(5),
    marketplace: z.string().min(1),
    ebayCondition: z.enum([
      "NEW",
      "LIKE_NEW",
      "USED_EXCELLENT",
      "USED_VERY_GOOD",
      "USED_GOOD",
      "USED_ACCEPTABLE",
      "FOR_PARTS_OR_NOT_WORKING",
    ]),
    itemSpecifics: z.record(z.string(), z.array(z.string().min(1))),
    reviewRevision: z.string().uuid(),
    connection: ebayConnectionStatusSchema,
    publishEligibility: z
      .object({
        enabled: z.boolean().nullable(),
        eligible: z.boolean().nullable(),
      })
      .strict(),
  })
  .strict();

export const ebayPublishPreflightEnvelopeSchema = z
  .object({ data: ebayPublishPreflightSchema, meta: apiMetaSchema })
  .strict();

export const ebayConnectionStatusEnvelopeSchema = z
  .object({ data: ebayConnectionSettingsSchema, meta: apiMetaSchema })
  .strict();

export const homeProjectionEnvelopeSchema = z
  .object({ data: homeProjectionSchema, meta: apiMetaSchema })
  .strict();

const nullableTimestampSchema = z.string().datetime({ offset: true }).nullable();

export const mobileRunSchema = z
  .object({
    id: z.string().uuid(),
    itemId: z.string().uuid(),
    listingId: z.string().uuid().nullable(),
    status: z.enum(["queued", "running", "retrying", "succeeded", "failed", "canceled"]),
    stage: z.enum(["queued", "identifying", "pricing", "generating", "persisting", "completed"]),
    attemptCount: z.number().int().nonnegative(),
    maxAttempts: z.number().int().positive(),
    schemaVersion: z.literal(1),
    timestamps: z
      .object({
        createdAt: z.string().datetime({ offset: true }),
        updatedAt: z.string().datetime({ offset: true }),
        enqueuedAt: nullableTimestampSchema,
        startedAt: nullableTimestampSchema,
        lastAttemptedAt: nullableTimestampSchema,
        nextAttemptAt: nullableTimestampSchema,
        completedAt: nullableTimestampSchema,
        retentionCleanedAt: nullableTimestampSchema,
      })
      .strict(),
    item: z
      .object({ title: z.string().min(1), photoCount: z.number().int().nonnegative() })
      .strict()
      .nullable()
      .optional(),
    requiredInput: z
      .object({
        reason: z.string().min(1),
        destination: z.enum(["identity", "photos", "listing"]),
      })
      .strict()
      .nullable(),
    terminalOutcome: z.enum(["succeeded", "failed", "canceled"]).nullable(),
    safeFailure: z
      .object({
        reason: z.string().min(1),
        detail: z.string().min(1),
        retryable: z.boolean(),
        workPreserved: z.boolean(),
      })
      .strict()
      .nullable(),
    allowance: z.enum(["reserved", "settled", "restored", "unchanged"]),
    legalActions: z
      .object({
        canRetry: z.boolean(),
        canCancel: z.boolean(),
        canOpenReview: z.boolean(),
        canStartNewCapture: z.boolean(),
      })
      .strict(),
    review: listingReviewProjectionSchema.optional(),
    delivery: z
      .object({
        state: z.enum(["published_to_ebay", "export_prepared"]),
        coverPhotoUrl: z.string().url().optional(),
      })
      .strict()
      .optional(),
    lastMeaningfulUpdateAt: z.string().datetime({ offset: true }),
    retentionCleanedAt: nullableTimestampSchema,
  })
  .strict();

export type MobileRun = z.infer<typeof mobileRunSchema>;

export const mobileRunEnvelopeSchema = z
  .object({ data: mobileRunSchema, meta: apiMetaSchema })
  .strict();

export const listingReviewSaveEnvelopeSchema = z
  .object({ data: listingReviewSaveReceiptSchema, meta: apiMetaSchema })
  .strict();

export const guidedCorrectionEnvelopeSchema = z
  .object({ data: guidedCorrectionReceiptSchema, meta: apiMetaSchema })
  .strict();

export const mobileRunHistoryOrderKeySchema = z
  .object({
    lastMeaningfulUpdateAt: z.string().datetime({ offset: true }),
    runId: z.string().uuid(),
  })
  .strict();

export const mobileRunCollectionEntrySchema = z
  .object({
    run: mobileRunSchema,
    logicalIdentity: z
      .object({
        idempotencyKey: z.string().min(1).max(128),
      })
      .strict(),
    orderKey: mobileRunHistoryOrderKeySchema,
  })
  .strict();

export const mobileRunCollectionSchema = z
  .object({
    entries: z.array(mobileRunCollectionEntrySchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export type MobileRunCollection = z.infer<typeof mobileRunCollectionSchema>;

export const mobileRunCollectionEnvelopeSchema = z
  .object({ data: mobileRunCollectionSchema, meta: apiMetaSchema })
  .strict();

export const pricingEvidenceEnvelopeSchema = z
  .object({ data: pricingEvidenceProjectionSchema, meta: apiMetaSchema })
  .strict();

/**
 * One assisted destination as the native client is allowed to describe it.
 * `state` carries only what SnapList can actually know — it prepared a pack,
 * and the seller either did or did not say they posted it. `published`,
 * `listed`, `sold`, and `verified` are unknowable for Facebook Marketplace,
 * Mercari, and Depop, so the wire format cannot express them.
 */
export const exportHandoffViewSchema = z
  .object({
    platform: z.enum(ASSISTED_EXPORT_PLATFORMS),
    state: z.enum(["prepared", "shared"]),
    handedOffAt: z.string().datetime({ offset: true }).nullable(),
    sharedAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const exportHandoffsEnvelopeSchema = z
  .object({
    data: z
      .object({
        handoffs: z.array(exportHandoffViewSchema).length(3),
        pack: z
          .object({
            effectivePrice: z.number().positive().multipleOf(0.01),
            reviewRevision: z.string().uuid(),
          })
          .strict(),
      })
      .strict(),
    meta: apiMetaSchema,
  })
  .strict();

/**
 * The seller's three truthful actions. Each maps one-to-one onto a guarded
 * RPC, and each carries both revisions so the database keeps the staleness
 * decision. `shared` is separate from `handoff` on purpose: only the explicit
 * confirmation is a claim, and no client may reach it by any other route.
 */
export const exportHandoffActionSchema = z
  .object({
    platform: z.enum(ASSISTED_EXPORT_PLATFORMS),
    action: z.enum(["handoff", "shared", "undo"]),
    reviewContentRevision: z.string().uuid(),
    reviewRevision: z.string().uuid(),
  })
  .strict();

/**
 * What the seller is told after deleting an item (#181).
 *
 * `retainedRecords` is not a footnote. SnapList deletes what SnapList owns; a
 * live eBay listing stays live because ending it is the seller's action on
 * eBay. Naming those records is the difference between an honest receipt and a
 * claim that SnapList erased something it cannot reach.
 */
export const itemDeletionEnvelopeSchema = z
  .object({
    data: z
      .object({
        itemId: z.string().uuid(),
        retainedRecords: z.array(z.string().min(1)),
      })
      .strict(),
    meta: apiMetaSchema,
  })
  .strict();

export const revenueCatConfigurationEnvelopeSchema = z
  .object({
    data: z
      .object({
        configured: z.boolean(),
        appUserId: z.string().min(1),
        publicSdkKey: z.string().min(1).optional(),
        entitlementId: z.string().min(1).optional(),
        monthlyProductId: z.string().min(1).optional(),
        offeringId: z.string().min(1).optional(),
        transitionState: z
          .enum(["not_required", "required", "reconciled"])
          .optional(),
        legacyStripeStatus: z.string().nullable().optional(),
      })
      .strict()
      .superRefine((data, context) => {
        if (
          data.configured &&
          (!data.publicSdkKey || !data.entitlementId || !data.monthlyProductId)
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Configured RevenueCat state needs server-provided SDK, entitlement, and monthly product identifiers.",
          });
        }
      }),
    meta: apiMetaSchema,
  })
  .strict();

export const aiItemEntitlementEnvelopeSchema = z
  .object({
    data: z
      .object({
        billingSource: z.enum(["included", "storekit", "none"]),
        status: z.enum([
          "included",
          "active",
          "grace",
          "billing_retry",
          "expired",
          "revoked",
          "refunded",
          "ambiguous",
          "unconfigured",
        ]),
        remainingItems: z.number().int().nonnegative(),
        periodStart: z.string().datetime().nullable(),
        periodEnd: z.string().datetime().nullable(),
        gracePeriodEnd: z.string().datetime().nullable(),
        transitionState: z
          .enum(["not_required", "required", "reconciled"])
          .nullable(),
        legacyStripeStatus: z.string().nullable(),
      })
      .strict(),
    meta: apiMetaSchema,
  })
  .strict();

export const workerSummaryEnvelopeSchema = z
  .object({ data: pipelineConsumerSummarySchema, meta: apiMetaSchema })
  .strict();

export const guestClaimEnvelopeSchema = z
  .object({ data: guestClaimTerminalOutcomeSchema, meta: apiMetaSchema })
  .strict();

export const includedOfferEnvelopeSchema = z
  .object({ data: includedOfferOutcomeSchema, meta: apiMetaSchema })
  .strict();
