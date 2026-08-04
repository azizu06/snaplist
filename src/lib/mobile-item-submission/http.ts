import { z } from "zod";
import {
  isMobileItemSubmissionDenied,
  isMobileItemSubmissionConflict,
  mobileItemSubmissionEnvelopeSchema,
  prepareMobileItemSubmission,
  type MobileItemSubmissionOperations,
} from "./contract";
import { parseBoundedMobileItemSubmissionMultipart } from "./bounded-multipart";

export interface MobileItemSubmissionHttpDependencies {
  itemSubmission: MobileItemSubmissionOperations;
  /** Defaults on for contract tests; production composition must opt in after #386. */
  acceptVoiceContext?: () => boolean;
  requestId?: () => string;
  reportError?: (context: string, error: unknown) => void;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function errorResponse(
  requestId: string,
  status: number,
  code: "unauthorized" | "forbidden" | "invalid_request" | "method_not_allowed" | "conflict" | "rate_limited" | "internal_error",
  message: string,
  details?: Record<string, unknown>,
): Response {
  return json({ error: { code, message, requestId, ...(details ? { details } : {}) } }, status);
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

/** Public web-standard POST /v1/items/runs transport seam. */
export function createMobileItemSubmissionHandler(
  dependencies: MobileItemSubmissionHttpDependencies,
): (request: Request) => Promise<Response> {
  const nextRequestId = dependencies.requestId ?? (() => crypto.randomUUID());
  return async (request) => {
    const requestId = nextRequestId();
    if (request.method !== "POST") {
      return errorResponse(requestId, 405, "method_not_allowed", "This method is not allowed.");
    }
    const token = bearerToken(request);
    if (!token) {
      return errorResponse(requestId, 401, "unauthorized", "Authentication is required.");
    }
    const idempotencyKey = z.string().uuid().safeParse(
      request.headers.get("idempotency-key")?.trim(),
    );
    if (!idempotencyKey.success) {
      return errorResponse(requestId, 400, "invalid_request", "A valid Idempotency-Key is required.");
    }

    let principal;
    try {
      principal = await dependencies.itemSubmission.resolvePrincipal(token);
    } catch (error) {
      dependencies.reportError?.("mobile-item-submission.authenticate", error);
      return errorResponse(requestId, 401, "unauthorized", "Authentication is required.");
    }

    let prepared;
    try {
      prepared = await prepareMobileItemSubmission(
        await parseBoundedMobileItemSubmissionMultipart(request),
        {
          acceptVoiceContext: dependencies.acceptVoiceContext?.() ?? true,
        },
      );
    } catch {
      return errorResponse(
        requestId,
        400,
        "invalid_request",
        "Submit 1–5 valid JPEG, PNG, or WebP photos and an optional cost basis.",
      );
    }
    if (
      (principal.kind === "verifiedGuest" && prepared.guestRecoveryIdentity === null)
      || (principal.kind === "clerk" && prepared.guestRecoveryIdentity !== null)
    ) {
      return errorResponse(
        requestId,
        400,
        "invalid_request",
        "Guest recovery identity must match the verified submission principal.",
      );
    }

    try {
      const result = await dependencies.itemSubmission.submit({
        principal,
        idempotencyKey: idempotencyKey.data,
        legacyRequestFingerprint: prepared.legacyRequestFingerprint,
        requestFingerprint: prepared.requestFingerprint,
        guestRecoveryIdentity: prepared.guestRecoveryIdentity,
        costBasis: prepared.costBasis,
        photos: prepared.photos,
        voice: prepared.voice,
      });
      return json(
        mobileItemSubmissionEnvelopeSchema.parse({
          data: {
            ...result.receipt,
            voiceContext: result.receipt.voiceContext ?? null,
          },
          meta: { requestId },
        }),
        result.outcome === "created" ? 202 : 200,
      );
    } catch (error) {
      if (isMobileItemSubmissionConflict(error)) {
        return errorResponse(
          requestId,
          409,
          "conflict",
          "The Idempotency-Key is already bound to another item submission.",
        );
      }
      if (isMobileItemSubmissionDenied(error)) {
        if (error.kind === "allowance_denied") {
          return errorResponse(
            requestId,
            403,
            "forbidden",
            "An AI-item credit is not available for this submission.",
            { reason: error.reason },
          );
        }
        return errorResponse(
          requestId,
          429,
          "rate_limited",
          "The submission capacity limit has been reached.",
          { reason: error.reason },
        );
      }
      dependencies.reportError?.("mobile-item-submission.commit", error);
      return errorResponse(
        requestId,
        503,
        "internal_error",
        "The submission outcome is unknown. Retry with the same key and exact bytes.",
      );
    }
  };
}
