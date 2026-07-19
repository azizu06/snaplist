import type { PipelineWorker } from "@/lib/pipeline-queue/composition";
import type { NativeSubscriptionBridge } from "@/lib/billing";
import type { HomeProjectionReader } from "@/lib/home/projection";
import { z } from "zod";
import {
  GuestClaimInProgressError,
  type GuestClaimTerminalOutcome,
  type VerifiedGuestHandoff,
} from "@/lib/guest-recovery/service";
import {
  MOBILE_API_VERSION,
  apiErrorEnvelopeSchema,
  healthEnvelopeSchema,
  homeProjectionEnvelopeSchema,
  aiItemEntitlementEnvelopeSchema,
  guestClaimEnvelopeSchema,
  revenueCatConfigurationEnvelopeSchema,
  sessionEnvelopeSchema,
  workerSummaryEnvelopeSchema,
  type ApiErrorCode,
} from "./contract";

export interface MobileApiPrincipal {
  /** Clerk subject; this is the same text id used by Supabase RLS. */
  userId: string;
}

export interface MobileApiDependencies {
  /**
   * Verifies issuer, signature, expiry, subject, and any authorized-party claim for the opaque
   * Clerk bearer JWT before returning the RLS identity. Runtime adapters own
   * the concrete verifier; request bodies never supply a user id.
   */
  authenticate(token: string): Promise<MobileApiPrincipal>;
  /** #174 verifies the opaque App Attest/auth handoff; #175 consumes only this result. */
  verifyGuestClaimHandoff?: (token: string) => Promise<VerifiedGuestHandoff>;
  /** Authoritative #175 claim service. The target always comes from authenticate(). */
  claimGuestRecovery?: (input: {
    handoff: VerifiedGuestHandoff;
    targetUserId: string;
  }) => Promise<GuestClaimTerminalOutcome>;
  worker: PipelineWorker;
  subscriptionBridge?: NativeSubscriptionBridge;
  /** Read-only RLS projection for the native Seller Home. */
  homeProjection?: HomeProjectionReader;
  workerSecret?: string;
  requestId?: () => string;
  reportError?: (context: string, error: unknown) => void;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function errorResponse(
  requestId: string,
  status: number,
  code: ApiErrorCode,
  message: string,
): Response {
  return json(
    apiErrorEnvelopeSchema.parse({
      error: { code, message, requestId },
    }),
    status,
  );
}

/**
 * Web-standard HTTP module shared by a Node process and any future framework
 * adapter. It contains transport policy only; durable pipeline behavior stays
 * behind PipelineWorker.consume().
 */
export function createMobileApiHandler(
  dependencies: MobileApiDependencies,
): (request: Request) => Promise<Response> {
  const nextRequestId =
    dependencies.requestId ?? (() => globalThis.crypto.randomUUID());

  return async (request: Request): Promise<Response> => {
    const requestId = nextRequestId();
    const { pathname } = new URL(request.url);

    if (pathname === `/${MOBILE_API_VERSION}/health`) {
      if (request.method !== "GET") {
        return errorResponse(
          requestId,
          405,
          "method_not_allowed",
          "This method is not allowed.",
        );
      }
      return json(
        healthEnvelopeSchema.parse({
          data: { apiVersion: MOBILE_API_VERSION, status: "ok" },
          meta: { requestId },
        }),
      );
    }

    if (pathname === `/${MOBILE_API_VERSION}/session`) {
      if (request.method !== "GET") {
        return errorResponse(
          requestId,
          405,
          "method_not_allowed",
          "This method is not allowed.",
        );
      }
      const token = bearerToken(request);
      if (!token) {
        return errorResponse(
          requestId,
          401,
          "unauthorized",
          "Authentication is required.",
        );
      }
      try {
        const principal = await dependencies.authenticate(token);
        return json(
          sessionEnvelopeSchema.parse({
            data: { userId: principal.userId },
            meta: { requestId },
          }),
        );
      } catch (error) {
        dependencies.reportError?.("mobile-api.authenticate", error);
        return errorResponse(
          requestId,
          401,
          "unauthorized",
          "Authentication is required.",
        );
      }
    }

    if (pathname === `/${MOBILE_API_VERSION}/home`) {
      if (request.method !== "GET") {
        return errorResponse(requestId, 405, "method_not_allowed", "This method is not allowed.");
      }
      const token = bearerToken(request);
      if (!token) {
        return errorResponse(requestId, 401, "unauthorized", "Authentication is required.");
      }
      let principal: MobileApiPrincipal;
      try {
        principal = await dependencies.authenticate(token);
      } catch (error) {
        dependencies.reportError?.("mobile-api.authenticate", error);
        return errorResponse(requestId, 401, "unauthorized", "Authentication is required.");
      }
      if (!dependencies.homeProjection) {
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "Home is temporarily unavailable.",
        );
      }
      try {
        const projection = await dependencies.homeProjection.forSeller({
          userId: principal.userId,
          bearerToken: token,
        });
        return json(
          homeProjectionEnvelopeSchema.parse({
            data: projection,
            meta: { requestId },
          }),
        );
      } catch (error) {
        dependencies.reportError?.("mobile-api.home", error);
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "Home is temporarily unavailable.",
        );
      }
    }

    if (pathname === `/${MOBILE_API_VERSION}/guest/claims`) {
      if (request.method !== "POST") {
        return errorResponse(
          requestId,
          405,
          "method_not_allowed",
          "This method is not allowed.",
        );
      }
      const accountToken = bearerToken(request);
      const guestHandoffToken = request.headers
        .get("x-snaplist-guest-handoff")
        ?.trim();
      if (!accountToken || !guestHandoffToken) {
        return errorResponse(
          requestId,
          401,
          "unauthorized",
          "Authentication is required.",
        );
      }
      const idempotencyKey = z
        .string()
        .uuid()
        .safeParse(request.headers.get("idempotency-key")?.trim());
      if (!idempotencyKey.success) {
        return errorResponse(
          requestId,
          400,
          "invalid_request",
          "A valid Idempotency-Key is required.",
        );
      }
      if (
        !dependencies.verifyGuestClaimHandoff ||
        !dependencies.claimGuestRecovery
      ) {
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "Guest recovery is not configured.",
        );
      }

      let principal: MobileApiPrincipal;
      let handoff: VerifiedGuestHandoff;
      try {
        [principal, handoff] = await Promise.all([
          dependencies.authenticate(accountToken),
          dependencies.verifyGuestClaimHandoff(guestHandoffToken),
        ]);
      } catch (error) {
        dependencies.reportError?.("mobile-api.guest-claim-authenticate", error);
        return errorResponse(
          requestId,
          401,
          "unauthorized",
          "Authentication is required.",
        );
      }

      try {
        const outcome = await dependencies.claimGuestRecovery({
          handoff,
          targetUserId: principal.userId,
        });
        return json(
          guestClaimEnvelopeSchema.parse({
            data: outcome,
            meta: { requestId },
          }),
        );
      } catch (error) {
        if (error instanceof GuestClaimInProgressError) {
          return errorResponse(
            requestId,
            409,
            "conflict",
            "The guest draft claim is already in progress.",
          );
        }
        dependencies.reportError?.("mobile-api.guest-claim", error);
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "The guest draft could not be claimed. Retry before it expires.",
        );
      }
    }

    if (pathname === `/${MOBILE_API_VERSION}/billing/revenuecat/identity`) {
      if (request.method !== "POST") {
        return errorResponse(requestId, 405, "method_not_allowed", "This method is not allowed.");
      }
      const token = bearerToken(request);
      if (!token) {
        return errorResponse(requestId, 401, "unauthorized", "Authentication is required.");
      }
      if (!dependencies.subscriptionBridge) {
        return errorResponse(requestId, 503, "internal_error", "Native subscriptions are not configured.");
      }
      let principal: MobileApiPrincipal;
      try {
        principal = await dependencies.authenticate(token);
      } catch (error) {
        dependencies.reportError?.("mobile-api.authenticate", error);
        return errorResponse(requestId, 401, "unauthorized", "Authentication is required.");
      }
      try {
        const configuration = await dependencies.subscriptionBridge.configurationFor(
          principal.userId,
        );
        return json(
          revenueCatConfigurationEnvelopeSchema.parse({
            data: configuration,
            meta: { requestId },
          }),
        );
      } catch (error) {
        dependencies.reportError?.("mobile-api.revenuecat-identity", error);
        return errorResponse(requestId, 500, "internal_error", "Native subscription setup failed.");
      }
    }

    if (pathname === `/${MOBILE_API_VERSION}/entitlements/ai-items`) {
      if (request.method !== "GET") {
        return errorResponse(requestId, 405, "method_not_allowed", "This method is not allowed.");
      }
      const token = bearerToken(request);
      if (!token) {
        return errorResponse(requestId, 401, "unauthorized", "Authentication is required.");
      }
      if (!dependencies.subscriptionBridge) {
        return errorResponse(requestId, 503, "internal_error", "Native subscriptions are not configured.");
      }
      let principal: MobileApiPrincipal;
      try {
        principal = await dependencies.authenticate(token);
      } catch (error) {
        dependencies.reportError?.("mobile-api.authenticate", error);
        return errorResponse(requestId, 401, "unauthorized", "Authentication is required.");
      }
      try {
        const entitlement = await dependencies.subscriptionBridge.entitlementFor(
          principal.userId,
        );
        return json(
          aiItemEntitlementEnvelopeSchema.parse({
            data: entitlement,
            meta: { requestId },
          }),
        );
      } catch (error) {
        dependencies.reportError?.("mobile-api.ai-item-entitlement", error);
        return errorResponse(requestId, 500, "internal_error", "Verified entitlement lookup failed.");
      }
    }

    if (pathname === "/internal/v1/pipeline/consume") {
      if (request.method !== "POST") {
        return errorResponse(
          requestId,
          405,
          "method_not_allowed",
          "This method is not allowed.",
        );
      }
      const token = bearerToken(request);
      if (!dependencies.workerSecret || token !== dependencies.workerSecret) {
        return errorResponse(
          requestId,
          401,
          "unauthorized",
          "Authentication is required.",
        );
      }
      try {
        const summary = await dependencies.worker.consume();
        return json(
          workerSummaryEnvelopeSchema.parse({
            data: summary,
            meta: { requestId },
          }),
        );
      } catch (error) {
        dependencies.reportError?.("mobile-api.pipeline-worker", error);
        return errorResponse(
          requestId,
          500,
          "internal_error",
          "The pipeline worker could not start.",
        );
      }
    }

    return errorResponse(
      requestId,
      404,
      "not_found",
      "This endpoint does not exist.",
    );
  };
}
