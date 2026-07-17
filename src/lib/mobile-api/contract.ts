import { z } from "zod";
import { pipelineConsumerSummarySchema } from "./worker-summary";

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
