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

export const workerSummaryEnvelopeSchema = z
  .object({ data: pipelineConsumerSummarySchema, meta: apiMetaSchema })
  .strict();
