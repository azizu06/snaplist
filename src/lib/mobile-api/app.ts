import type { PipelineWorker } from "@/lib/pipeline-queue/composition";
import type { NativeSubscriptionBridge } from "@/lib/billing";
import type { HomeProjectionReader } from "@/lib/home/projection";
import type { PricingEvidenceReader } from "@/lib/pricing-evidence";
import {
  ASSISTED_EXPORT_PLATFORMS,
  type AssistedExportPlatform,
  type ExportHandoffPackProjection,
} from "@/lib/export/handoff";
import type { ListingReviewReader } from "@/lib/listing-review";
import {
  ListingReviewIdempotencyConflictError,
  ListingReviewNotEditableError,
  listingReviewSaveIntentSchema,
  ListingReviewSaveInProgressError,
  ListingReviewStaleError,
  type ListingReviewSaver,
} from "@/lib/listing-review/save";
import {
  GuidedCorrectionIdempotencyConflictError,
  GuidedCorrectionInProgressError,
  GuidedCorrectionNotEditableError,
  GuidedCorrectionNotFoundError,
  GuidedCorrectionNotPricedError,
  GuidedCorrectionStaleError,
  GuidedCorrectionUnavailableError,
  guidedCorrectionIntentSchema,
  type GuidedCorrector,
} from "./guided-correction";
import {
  MobileRunConflictError,
  MobileRunInvalidCursorError,
  MobileRunNotFoundError,
  type MobileRunHistoryReader,
  type MobileRunOperations,
} from "./runs";
import { z } from "zod";
import {
  GuestClaimAllowanceInFlightError,
  GuestClaimAllowanceSpentError,
  GuestClaimIdempotencyConflictError,
  GuestClaimInProgressError,
  type GuestClaimTerminalOutcome,
  type VerifiedGuestHandoff,
} from "@/lib/guest-recovery/service";
import {
  includedOfferDeviceTokenRequestSchema,
  includedOfferHttpStatus,
  includedOfferRedeemRequestSchema,
} from "@/lib/included-offer-fence/http";
import type { IncludedOfferFence } from "@/lib/included-offer-fence/service";
import {
  MobileEbayListingNotFoundError,
  type MobileEbayPublishGateway,
} from "@/lib/marketplace/ebay/mobile-publish";
import {
  PublishedReplayConflictError,
  PublishReviewRevisionConflictError,
} from "@/lib/marketplace/ebay/publish";
import { PublishValidationError } from "@/lib/marketplace/ebay/errors";
import {
  MOBILE_API_VERSION,
  apiErrorEnvelopeSchema,
  includedOfferEnvelopeSchema,
  healthEnvelopeSchema,
  homeProjectionEnvelopeSchema,
  mobileRunCollectionEnvelopeSchema,
  mobileRunEnvelopeSchema,
  listingReviewSaveEnvelopeSchema,
  pricingEvidenceEnvelopeSchema,
  exportHandoffActionSchema,
  exportHandoffsEnvelopeSchema,
  aiItemEntitlementEnvelopeSchema,
  ebayConnectionStatusEnvelopeSchema,
  ebayOauthSessionEnvelopeSchema,
  ebayPublishConfirmationSchema,
  ebayPublishPreflightEnvelopeSchema,
  ebayPublishStatusEnvelopeSchema,
  guidedCorrectionEnvelopeSchema,
  guestClaimEnvelopeSchema,
  revenueCatConfigurationEnvelopeSchema,
  sessionEnvelopeSchema,
  workerSummaryEnvelopeSchema,
  type ApiErrorCode,
  type EbayOauthSession,
} from "./contract";

export interface MobileApiPrincipal {
  /** Clerk subject; this is the same text id used by Supabase RLS. */
  userId: string;
  kind?: "clerk" | "verifiedGuest";
  /** Guest principals mint one fresh project JWT for each protected RLS operation. */
  mintOperationToken?: () => Promise<string>;
}

/**
 * The RLS-scoped assisted-export capability from #580, seen from transport.
 *
 * Every method takes the caller's identity and bearer so the adapter builds a
 * user-scoped client; nothing here is a service-role path. The route composes
 * no state of its own: after any mutation it re-reads through `load`, because
 * each mutation RPC reports one timestamp and a view assembled from that would
 * describe a destination by the last thing that happened to it rather than by
 * what is true of it now.
 */
export interface AssistedExportHandoffGateway {
  load(input: {
    userId: string;
    bearerToken: string;
    itemId: string;
    reviewContentRevision: string;
  }): Promise<ExportHandoffPackProjection>;
  recordHandoff(input: AssistedExportGatewayMutation): Promise<string>;
  markShared(input: AssistedExportGatewayMutation): Promise<string>;
  undoShared(input: AssistedExportGatewayMutation): Promise<void>;
}

export interface AssistedExportGatewayMutation {
  userId: string;
  bearerToken: string;
  itemId: string;
  platform: AssistedExportPlatform;
  reviewContentRevision: string;
  reviewRevision: string;
}

export interface MobileApiDependencies {
  /**
   * Verifies issuer, signature, expiry, subject, and any authorized-party claim for the opaque
   * Clerk bearer JWT before returning the RLS identity. Runtime adapters own
   * the concrete verifier; request bodies never supply a user id.
   */
  authenticate(token: string): Promise<MobileApiPrincipal>;
  /** #387 owns the tenant-bound, one-time mobile eBay Sandbox OAuth seam. */
  ebayOauth?: {
    createSession(input: {
      userId: string;
      bearerToken: string;
      idempotencyKey: string;
    }): Promise<EbayOauthSession>;
    completeCallback?(input: {
      state: string;
      code: string | null;
      error: string | null;
      errorDescription: string | null;
    }): Promise<{ redirectUrl: string }>;
  };
  /** RLS-scoped server truth and exact-once eBay publish service. */
  ebayPublish?: MobileEbayPublishGateway;
  /** #174 verifies the opaque App Attest/auth handoff; #175 consumes only this result. */
  verifyGuestClaimHandoff?: (token: string) => Promise<VerifiedGuestHandoff>;
  /** Authoritative #175 claim service. The target always comes from authenticate(). */
  claimGuestRecovery?: (input: {
    bearerToken: string;
    handoff: VerifiedGuestHandoff;
    idempotencyKey: string;
    targetUserId: string;
  }) => Promise<GuestClaimTerminalOutcome>;
  /**
   * #524 device fence. Absent means the fence is unconfigured, which denies the
   * included offer rather than granting an unfenced one.
   */
  includedOffer?: IncludedOfferFence;
  worker: PipelineWorker;
  subscriptionBridge?: NativeSubscriptionBridge;
  /** Read-only RLS projection for the native Seller Home. */
  homeProjection?: HomeProjectionReader;
  /** Authenticated, tenant/RLS-scoped view of canonical #161 durable-run truth. */
  runOperations?: MobileRunOperations;
  /** Snapshot-stable tenant/RLS-scoped chronological run collection. */
  runHistory?: MobileRunHistoryReader;
  /** Immutable, run-coherent RLS pricing evidence for native item detail. */
  pricingEvidence?: PricingEvidenceReader;
  /** One strict run-bound Listing Review projection. */
  listingReview?: ListingReviewReader;
  /** One run-bound, idempotent Listing Review mutation. */
  listingReviewSave?: ListingReviewSaver;
  /** Guided identity correction — the native "Sharpen the estimate" seam. */
  guidedCorrection?: GuidedCorrector;
  /** Transport over the #580 assisted-export seam; it adds no authority. */
  assistedExport?: AssistedExportHandoffGateway;
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
  details?: Record<string, unknown>,
): Response {
  return json(
    apiErrorEnvelopeSchema.parse({
      error: {
        code,
        message,
        requestId,
        ...(details ? { details } : {}),
      },
    }),
    status,
  );
}

async function authenticatedEbayAccount(
  request: Request,
  requestId: string,
  dependencies: MobileApiDependencies,
): Promise<{ principal: MobileApiPrincipal; token: string } | Response> {
  const token = bearerToken(request);
  if (!token) {
    return errorResponse(
      requestId,
      401,
      "unauthorized",
      "Authentication is required.",
    );
  }
  let principal: MobileApiPrincipal;
  try {
    principal = await dependencies.authenticate(token);
  } catch (error) {
    dependencies.reportError?.("mobile-api.authenticate", error);
    return errorResponse(
      requestId,
      401,
      "unauthorized",
      "Authentication is required.",
    );
  }
  if (principal.kind === "verifiedGuest") {
    return errorResponse(
      requestId,
      403,
      "forbidden",
      "eBay delivery requires an account.",
    );
  }
  return { principal, token };
}

/**
 * Translate a refused assisted-export RPC into a status the native client can
 * act on. The Postgres code is the machine-readable half of the refusal and
 * collapsing it would leave the client unable to tell "your listing moved,
 * reopen the sheet" from "this can never work". None of these messages may
 * name a destination state, since a refusal is precisely the case where
 * SnapList knows nothing new about it.
 */
function exportHandoffFailure(requestId: string, error: unknown): Response {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  switch (code) {
    case "P0002":
      return errorResponse(
        requestId,
        409,
        "conflict",
        "This listing changed after the pack was prepared.",
      );
    case "22023":
      return errorResponse(
        requestId,
        422,
        "invalid_request",
        "This destination does not accept an assisted handoff.",
      );
    case "42501":
      return errorResponse(
        requestId,
        403,
        "forbidden",
        "This item belongs to another account.",
      );
    default:
      return errorResponse(
        requestId,
        503,
        "internal_error",
        "Sharing to other marketplaces is temporarily unavailable.",
      );
  }
}

/**
 * Web-standard HTTP module shared by a Node process and any future framework
 * adapter. It contains transport policy only; durable behavior stays behind
 * injected, narrowly scoped capabilities.
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

    if (pathname === `/${MOBILE_API_VERSION}/runs`) {
      if (request.method !== "GET") {
        return errorResponse(
          requestId,
          405,
          "method_not_allowed",
          "This method is not allowed.",
        );
      }
      const url = new URL(request.url);
      const query = z
        .object({
          limit: z.coerce.number().int().min(1).max(50).default(20),
          cursor: z.string().min(1).optional(),
        })
        .strict()
        .safeParse({
          limit: url.searchParams.get("limit") ?? undefined,
          cursor: url.searchParams.get("cursor") ?? undefined,
        });
      if (!query.success) {
        return errorResponse(
          requestId,
          400,
          "invalid_request",
          "A valid run-history query is required.",
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
      let principal: MobileApiPrincipal;
      try {
        principal = await dependencies.authenticate(token);
      } catch (error) {
        dependencies.reportError?.("mobile-api.authenticate", error);
        return errorResponse(
          requestId,
          401,
          "unauthorized",
          "Authentication is required.",
        );
      }
      if (principal.kind === "verifiedGuest") {
        return errorResponse(
          requestId,
          403,
          "forbidden",
          "Run history requires an account.",
        );
      }
      if (!dependencies.runHistory) {
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "Run history is temporarily unavailable.",
        );
      }
      try {
        const history = await dependencies.runHistory.list({
          userId: principal.userId,
          bearerToken: token,
          ...query.data,
        });
        return json(
          mobileRunCollectionEnvelopeSchema.parse({
            data: history,
            meta: { requestId },
          }),
        );
      } catch (error) {
        if (error instanceof MobileRunInvalidCursorError) {
          return errorResponse(
            requestId,
            400,
            "invalid_request",
            "The run-history cursor is invalid.",
          );
        }
        dependencies.reportError?.("mobile-api.run-history", error);
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "Run history is temporarily unavailable.",
        );
      }
    }

    if (pathname === `/${MOBILE_API_VERSION}/ebay/oauth/sessions`) {
      if (request.method !== "POST") {
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

      let principal: MobileApiPrincipal;
      try {
        principal = await dependencies.authenticate(token);
      } catch (error) {
        dependencies.reportError?.("mobile-api.authenticate", error);
        return errorResponse(
          requestId,
          401,
          "unauthorized",
          "Authentication is required.",
        );
      }
      if (!dependencies.ebayOauth) {
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "eBay connection is temporarily unavailable.",
        );
      }
      try {
        const session = await dependencies.ebayOauth.createSession({
          userId: principal.userId,
          bearerToken: token,
          idempotencyKey: idempotencyKey.data,
        });
        return json(
          ebayOauthSessionEnvelopeSchema.parse({
            data: session,
            meta: { requestId },
          }),
          201,
        );
      } catch (error) {
        dependencies.reportError?.("mobile-api.ebay-oauth-session", error);
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "eBay connection is temporarily unavailable.",
        );
      }
    }

    if (pathname === `/${MOBILE_API_VERSION}/ebay/oauth/callback`) {
      if (request.method !== "GET") {
        return errorResponse(
          requestId,
          405,
          "method_not_allowed",
          "This method is not allowed.",
        );
      }
      const callbackUrl = new URL(request.url);
      const state = callbackUrl.searchParams.get("state");
      if (!state) {
        return errorResponse(
          requestId,
          400,
          "invalid_request",
          "A valid eBay OAuth state is required.",
        );
      }
      if (!dependencies.ebayOauth?.completeCallback) {
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "eBay connection is temporarily unavailable.",
        );
      }
      try {
        const result = await dependencies.ebayOauth.completeCallback({
          state,
          code: callbackUrl.searchParams.get("code"),
          error: callbackUrl.searchParams.get("error"),
          errorDescription: callbackUrl.searchParams.get("error_description"),
        });
        return new Response(null, {
          status: 303,
          headers: { location: result.redirectUrl },
        });
      } catch (error) {
        dependencies.reportError?.("mobile-api.ebay-oauth-callback", error);
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "eBay connection is temporarily unavailable.",
        );
      }
    }

    if (pathname === `/${MOBILE_API_VERSION}/ebay/connection`) {
      if (request.method !== "GET" && request.method !== "DELETE") {
        return errorResponse(
          requestId,
          405,
          "method_not_allowed",
          "This method is not allowed.",
        );
      }
      const authenticated = await authenticatedEbayAccount(
        request,
        requestId,
        dependencies,
      );
      if (authenticated instanceof Response) return authenticated;
      const { principal, token } = authenticated;
      if (!dependencies.ebayPublish) {
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "eBay connection settings are temporarily unavailable.",
        );
      }
      try {
        const operation = {
          userId: principal.userId,
          bearerToken: token,
        };
        const status = request.method === "GET"
          ? await dependencies.ebayPublish.connection(operation)
          : await dependencies.ebayPublish.disconnect(operation);
        return json(
          ebayConnectionStatusEnvelopeSchema.parse({
            data: status,
            meta: { requestId },
          }),
        );
      } catch (error) {
        dependencies.reportError?.("mobile-api.ebay-connection", error);
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "eBay connection settings are temporarily unavailable.",
        );
      }
    }

    const ebayPublishPath = pathname.match(
      new RegExp(`^/${MOBILE_API_VERSION}/listings/([^/]+)/ebay/publish$`),
    );
    if (ebayPublishPath) {
      if (request.method !== "GET" && request.method !== "POST") {
        return errorResponse(
          requestId,
          405,
          "method_not_allowed",
          "This method is not allowed.",
        );
      }
      const listingId = z.string().uuid().safeParse(ebayPublishPath[1]);
      if (!listingId.success) {
        return errorResponse(
          requestId,
          400,
          "invalid_request",
          "A valid listing ID is required.",
        );
      }
      const idempotencyKey = request.method === "POST"
        ? z
            .string()
            .uuid()
            .safeParse(request.headers.get("idempotency-key")?.trim())
        : null;
      const confirmation = request.method === "POST"
        ? ebayPublishConfirmationSchema.safeParse(
            await request.json().catch(() => null),
          )
        : null;
      const publishIntent =
        idempotencyKey?.success && confirmation?.success
          ? {
              expectedReviewRevision:
                confirmation.data.expectedReviewRevision,
              idempotencyKey: idempotencyKey.data,
            }
          : null;
      if (
        request.method === "POST"
        && !publishIntent
      ) {
        return errorResponse(
          requestId,
          400,
          "invalid_request",
          "A confirmed publish, current review revision, and Idempotency-Key are required.",
        );
      }
      const authenticated = await authenticatedEbayAccount(
        request,
        requestId,
        dependencies,
      );
      if (authenticated instanceof Response) return authenticated;
      const { principal, token } = authenticated;
      if (!dependencies.ebayPublish) {
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "eBay publishing is temporarily unavailable.",
        );
      }
      try {
        const operation = {
          userId: principal.userId,
          bearerToken: token,
          listingId: listingId.data,
        };
        const outcome = request.method === "GET"
          ? await dependencies.ebayPublish.status(operation)
          : await dependencies.ebayPublish.publish({
              ...operation,
              ...publishIntent!,
            });
        return json(
          ebayPublishStatusEnvelopeSchema.parse({
            data: outcome,
            meta: { requestId },
          }),
        );
      } catch (error) {
        if (error instanceof MobileEbayListingNotFoundError) {
          return errorResponse(
            requestId,
            404,
            "not_found",
            "This listing is unavailable.",
          );
        }
        // ORDER IS LOAD-BEARING: this 409 branch MUST stay above the 422
        // branch below. `PublishedReplayConflictError` and
        // `PublishReviewRevisionConflictError` both extend
        // `PublishValidationError` (publish.ts:111,113), so a 422 branch placed
        // first would swallow both — a stale-revision or already-published
        // conflict would answer 422 without its `reason`, and the client would
        // treat an authority conflict as a seller-fixable input problem.
        if (
          error instanceof PublishReviewRevisionConflictError
          || error instanceof PublishedReplayConflictError
        ) {
          const reason = error instanceof PublishedReplayConflictError
            ? "ebay_published_authority_changed"
            : "ebay_review_revision_changed";
          return errorResponse(
            requestId,
            409,
            "conflict",
            error.message,
            { reason },
          );
        }
        // A seller-fixable refusal — no return policy, more than one shipping
        // policy, no usable price. Its message is SAFE by construction (see
        // `PublishValidationError`), and the native client is the only launch
        // surface for publish, so redacting it to the generic 503 below leaves
        // the seller retrying a condition only they can clear. `cause`, when
        // present, is the internal failure behind that safe message and is the
        // part that belongs in the server log, never in the response.
        if (error instanceof PublishValidationError) {
          if (error.cause !== undefined) {
            dependencies.reportError?.("mobile-api.ebay-publish", error);
          }
          return errorResponse(requestId, 422, "invalid_request", error.message);
        }
        dependencies.reportError?.("mobile-api.ebay-publish", error);
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "eBay publishing is temporarily unavailable.",
        );
      }
    }

    const ebayPreflightPath = pathname.match(
      new RegExp(`^/${MOBILE_API_VERSION}/listings/([^/]+)/ebay/preflight$`),
    );
    if (ebayPreflightPath) {
      if (request.method !== "GET") {
        return errorResponse(
          requestId,
          405,
          "method_not_allowed",
          "This method is not allowed.",
        );
      }
      const listingId = z.string().uuid().safeParse(ebayPreflightPath[1]);
      if (!listingId.success) {
        return errorResponse(
          requestId,
          400,
          "invalid_request",
          "A valid listing ID is required.",
        );
      }
      const authenticated = await authenticatedEbayAccount(
        request,
        requestId,
        dependencies,
      );
      if (authenticated instanceof Response) return authenticated;
      const { principal, token } = authenticated;
      if (!dependencies.ebayPublish) {
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "eBay preflight is temporarily unavailable.",
        );
      }
      try {
        const preflight = await dependencies.ebayPublish.preflight({
          userId: principal.userId,
          bearerToken: token,
          listingId: listingId.data,
        });
        return json(
          ebayPublishPreflightEnvelopeSchema.parse({
            data: preflight,
            meta: { requestId },
          }),
        );
      } catch (error) {
        if (error instanceof MobileEbayListingNotFoundError) {
          return errorResponse(
            requestId,
            404,
            "not_found",
            "This listing is unavailable.",
          );
        }
        // Preflight refuses for the SAME seller-fixable reasons publish does —
        // no usable price, no title — so it classifies identically. Answering
        // 503 on the screen that exists to surface those conditions tells the
        // seller to retry something only they can clear.
        if (error instanceof PublishValidationError) {
          if (error.cause !== undefined) {
            dependencies.reportError?.("mobile-api.ebay-preflight", error);
          }
          return errorResponse(requestId, 422, "invalid_request", error.message);
        }
        dependencies.reportError?.("mobile-api.ebay-preflight", error);
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "eBay preflight is temporarily unavailable.",
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

    const listingReviewSavePath = pathname.match(
      new RegExp(`^/${MOBILE_API_VERSION}/runs/([^/]+)/review$`),
    );
    if (listingReviewSavePath) {
      if (request.method !== "PUT") {
        return errorResponse(
          requestId,
          405,
          "method_not_allowed",
          "This method is not allowed.",
        );
      }
      const runId = z.string().uuid().safeParse(listingReviewSavePath[1]);
      const idempotencyKey = z
        .string()
        .uuid()
        .safeParse(request.headers.get("idempotency-key")?.trim());
      let requestBody: unknown;
      try {
        requestBody = await request.json();
      } catch {
        requestBody = null;
      }
      const intent = listingReviewSaveIntentSchema.safeParse(requestBody);
      if (!runId.success || !idempotencyKey.success || !intent.success) {
        return errorResponse(
          requestId,
          400,
          "invalid_request",
          !runId.success
            ? "A valid run ID is required."
            : !idempotencyKey.success
              ? "A valid Idempotency-Key is required."
              : "A valid Listing Review save is required.",
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
      let principal: MobileApiPrincipal;
      try {
        principal = await dependencies.authenticate(token);
      } catch (error) {
        dependencies.reportError?.("mobile-api.authenticate", error);
        return errorResponse(
          requestId,
          401,
          "unauthorized",
          "Authentication is required.",
        );
      }
      if (!dependencies.listingReviewSave) {
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "Listing Review save is temporarily unavailable.",
        );
      }
      try {
        const receipt = await dependencies.listingReviewSave.save({
          runId: runId.data,
          idempotencyKey: idempotencyKey.data,
          intent: intent.data,
          userId: principal.userId,
          bearerToken: token,
          mintOperationToken: principal.mintOperationToken,
        });
        return json(
          listingReviewSaveEnvelopeSchema.parse({
            data: receipt,
            meta: { requestId },
          }),
        );
      } catch (error) {
        if (
          error instanceof ListingReviewStaleError
          || error instanceof ListingReviewIdempotencyConflictError
          || error instanceof ListingReviewSaveInProgressError
          || error instanceof ListingReviewNotEditableError
        ) {
          return errorResponse(
            requestId,
            409,
            "conflict",
            error.message,
          );
        }
        dependencies.reportError?.("mobile-api.listing-review-save", error);
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "Listing Review save is temporarily unavailable.",
        );
      }
    }

    const guidedCorrectionPath = pathname.match(
      new RegExp(`^/${MOBILE_API_VERSION}/runs/([^/]+)/sharpen$`),
    );
    if (guidedCorrectionPath) {
      if (request.method !== "POST") {
        return errorResponse(
          requestId,
          405,
          "method_not_allowed",
          "This method is not allowed.",
        );
      }
      const runId = z.string().uuid().safeParse(guidedCorrectionPath[1]);
      // A correction spends real pricing-provider budget, so the key that makes
      // a retry free is required before the request is looked at any further.
      const idempotencyKey = z
        .string()
        .uuid()
        .safeParse(request.headers.get("idempotency-key")?.trim());
      let requestBody: unknown;
      try {
        requestBody = await request.json();
      } catch {
        requestBody = null;
      }
      const intent = guidedCorrectionIntentSchema.safeParse(requestBody);
      if (!runId.success || !idempotencyKey.success || !intent.success) {
        return errorResponse(
          requestId,
          400,
          "invalid_request",
          !runId.success
            ? "A valid run ID is required."
            : !idempotencyKey.success
              ? "A valid Idempotency-Key is required."
              : "A valid guided correction is required.",
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
      let principal: MobileApiPrincipal;
      try {
        principal = await dependencies.authenticate(token);
      } catch (error) {
        dependencies.reportError?.("mobile-api.authenticate", error);
        return errorResponse(
          requestId,
          401,
          "unauthorized",
          "Authentication is required.",
        );
      }
      if (!dependencies.guidedCorrection) {
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "Sharpening an estimate is temporarily unavailable.",
        );
      }
      try {
        const receipt = await dependencies.guidedCorrection.correct({
          runId: runId.data,
          idempotencyKey: idempotencyKey.data,
          userId: principal.userId,
          bearerToken: token,
          // A verified guest's capability bearer is not a project JWT, so
          // without this every read and write a guest attempts is refused by
          // PostgREST and surfaces as a 503 on the very path guest-first value
          // depends on.
          mintOperationToken: principal.mintOperationToken,
          intent: intent.data,
        });
        return json(
          guidedCorrectionEnvelopeSchema.parse({
            data: receipt,
            meta: { requestId },
          }),
        );
      } catch (error) {
        // A run the caller cannot see and a run that exists but is no longer
        // correctable are different answers: 404 leaks nothing about another
        // tenant's run, 409 tells the owner their own view went stale.
        if (error instanceof GuidedCorrectionNotFoundError) {
          return errorResponse(
            requestId,
            404,
            "not_found",
            "This run is unavailable.",
          );
        }
        if (
          error instanceof GuidedCorrectionStaleError
          || error instanceof GuidedCorrectionNotEditableError
          || error instanceof GuidedCorrectionNotPricedError
          || error instanceof GuidedCorrectionInProgressError
          || error instanceof GuidedCorrectionIdempotencyConflictError
          || error instanceof GuidedCorrectionUnavailableError
        ) {
          return errorResponse(requestId, 409, "conflict", error.message);
        }
        dependencies.reportError?.("mobile-api.guided-correction", error);
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "Sharpening an estimate is temporarily unavailable.",
        );
      }
    }

    const runRouteMatch = pathname.match(
      /^\/v1\/runs\/([^/]+)(?:\/(retry|cancel))?$/,
    );
    if (runRouteMatch) {
      const action = runRouteMatch[2] as "retry" | "cancel" | undefined;
      const expectedMethod = action ? "POST" : "GET";
      if (request.method !== expectedMethod) {
        return errorResponse(
          requestId,
          405,
          "method_not_allowed",
          "This method is not allowed.",
        );
      }

      const parsedRunId = z.string().uuid().safeParse(runRouteMatch[1]);
      const idempotencyKey = action
        ? z.string().uuid().safeParse(
            request.headers.get("idempotency-key")?.trim(),
          )
        : null;
      if (!parsedRunId.success || (idempotencyKey && !idempotencyKey.success)) {
        return errorResponse(
          requestId,
          400,
          "invalid_request",
          parsedRunId.success
            ? "A valid Idempotency-Key is required."
            : "A valid run ID is required.",
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

      let principal: MobileApiPrincipal;
      try {
        principal = await dependencies.authenticate(token);
      } catch (error) {
        dependencies.reportError?.("mobile-api.authenticate", error);
        return errorResponse(
          requestId,
          401,
          "unauthorized",
          "Authentication is required.",
        );
      }
      if (action && principal.kind === "verifiedGuest") {
        return errorResponse(
          requestId,
          403,
          "forbidden",
          "This run action requires an account.",
        );
      }

      const unavailableMessage = action
        ? `Run ${action === "retry" ? "retry" : "cancellation"} is temporarily unavailable.`
        : "Run status is temporarily unavailable.";
      if (!dependencies.runOperations) {
        return errorResponse(
          requestId,
          503,
          "internal_error",
          unavailableMessage,
        );
      }

      try {
        const runOperationToken =
          !action && principal.mintOperationToken
            ? await principal.mintOperationToken()
            : token;
        const baseInput = {
          runId: parsedRunId.data,
          userId: principal.userId,
          bearerToken: runOperationToken,
        };
        const run = action
          ? await dependencies.runOperations[action]({
              ...baseInput,
              idempotencyKey: idempotencyKey!.data,
            })
          : await dependencies.runOperations.get(baseInput);
        if (!run) {
          return errorResponse(
            requestId,
            404,
            "not_found",
            "This run is unavailable.",
          );
        }
        let responseRun = run;
        if (
          !action
          && run.status === "succeeded"
          && run.stage === "completed"
          && run.listingId
          && dependencies.listingReview
        ) {
          const review = await dependencies.listingReview.forRun({
            runId: run.id,
            userId: principal.userId,
            bearerToken: token,
            mintOperationToken: principal.mintOperationToken,
          });
          if (review) {
            if (
              review.binding.runId !== run.id
              || review.binding.itemId !== run.itemId
              || review.binding.listingId !== run.listingId
            ) {
              throw new Error(
                "Listing Review did not match the durable run projection.",
              );
            }
            responseRun = {
              ...run,
              legalActions: {
                ...run.legalActions,
                canOpenReview: true,
              },
              review,
            };
          }
        }
        return json(
          mobileRunEnvelopeSchema.parse({
            data: responseRun,
            meta: { requestId },
          }),
          action === "retry" ? 202 : 200,
        );
      } catch (error) {
        if (error instanceof MobileRunNotFoundError) {
          return errorResponse(
            requestId,
            404,
            "not_found",
            "This run is unavailable.",
          );
        }
        if (error instanceof MobileRunConflictError) {
          return errorResponse(
            requestId,
            409,
            "conflict",
            "The run changed. Refresh its latest status before trying again.",
          );
        }
        dependencies.reportError?.(
          `mobile-api.run-${action ?? "detail"}`,
          error,
        );
        return errorResponse(
          requestId,
          503,
          "internal_error",
          unavailableMessage,
        );
      }
    }

    const pricingPath = pathname.match(
      new RegExp(`^/${MOBILE_API_VERSION}/items/([^/]+)/pricing$`),
    );
    if (pricingPath) {
      if (request.method !== "GET") {
        return errorResponse(requestId, 405, "method_not_allowed", "This method is not allowed.");
      }
      const token = bearerToken(request);
      if (!token) {
        return errorResponse(requestId, 401, "unauthorized", "Authentication is required.");
      }
      const itemId = z.string().uuid().safeParse(pricingPath[1]);
      if (!itemId.success) {
        return errorResponse(requestId, 400, "invalid_request", "A valid item id is required.");
      }
      let principal: MobileApiPrincipal;
      try {
        principal = await dependencies.authenticate(token);
      } catch (error) {
        dependencies.reportError?.("mobile-api.authenticate", error);
        return errorResponse(requestId, 401, "unauthorized", "Authentication is required.");
      }
      if (!dependencies.pricingEvidence) {
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "Pricing evidence is temporarily unavailable.",
        );
      }
      try {
        const pricing = await dependencies.pricingEvidence.forItem({
          userId: principal.userId,
          bearerToken: token,
          itemId: itemId.data,
        });
        if (!pricing) {
          return errorResponse(
            requestId,
            404,
            "not_found",
            "Pricing evidence was not found for this item.",
          );
        }
        return json(
          pricingEvidenceEnvelopeSchema.parse({
            data: pricing,
            meta: { requestId },
          }),
        );
      } catch (error) {
        dependencies.reportError?.("mobile-api.pricing-evidence", error);
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "Pricing evidence is temporarily unavailable.",
        );
      }
    }

    const exportHandoffPath = pathname.match(
      new RegExp(`^/${MOBILE_API_VERSION}/items/([^/]+)/export-handoffs$`),
    );
    if (exportHandoffPath) {
      if (request.method !== "GET" && request.method !== "POST") {
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
      const itemId = z.string().uuid().safeParse(exportHandoffPath[1]);
      if (!itemId.success) {
        return errorResponse(
          requestId,
          400,
          "invalid_request",
          "A valid item id is required.",
        );
      }

      // A mutation and a read need different inputs, but both must name the
      // pack revision. Parsing before authenticating keeps a malformed body
      // from reaching the capability at all.
      let mutation: z.infer<typeof exportHandoffActionSchema> | null = null;
      let reviewContentRevision: string;
      if (request.method === "POST") {
        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return errorResponse(
            requestId,
            400,
            "invalid_request",
            "A valid request body is required.",
          );
        }
        const parsed = exportHandoffActionSchema.safeParse(body);
        if (!parsed.success) {
          return errorResponse(
            requestId,
            400,
            "invalid_request",
            "A valid assisted export action is required.",
          );
        }
        mutation = parsed.data;
        reviewContentRevision = parsed.data.reviewContentRevision;
      } else {
        const revision = z
          .string()
          .uuid()
          .safeParse(
            new URL(request.url).searchParams.get("reviewContentRevision"),
          );
        if (!revision.success) {
          return errorResponse(
            requestId,
            400,
            "invalid_request",
            "A valid pack revision is required.",
          );
        }
        reviewContentRevision = revision.data;
      }

      let principal: MobileApiPrincipal;
      try {
        principal = await dependencies.authenticate(token);
      } catch (error) {
        dependencies.reportError?.("mobile-api.authenticate", error);
        return errorResponse(
          requestId,
          401,
          "unauthorized",
          "Authentication is required.",
        );
      }
      const assistedExport = dependencies.assistedExport;
      if (!assistedExport) {
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "Sharing to other marketplaces is temporarily unavailable.",
        );
      }

      try {
        if (mutation) {
          const input = {
            userId: principal.userId,
            bearerToken: token,
            itemId: itemId.data,
            platform: mutation.platform,
            reviewContentRevision: mutation.reviewContentRevision,
            reviewRevision: mutation.reviewRevision,
          };
          if (mutation.action === "handoff") {
            await assistedExport.recordHandoff(input);
          } else if (mutation.action === "shared") {
            await assistedExport.markShared(input);
          } else {
            await assistedExport.undoShared(input);
          }
        }
        // Read after the write, never around it: the response describes what
        // the database now holds, so a refused mutation can never be painted
        // over with the state the client hoped for.
        const view = await assistedExport.load({
          userId: principal.userId,
          bearerToken: token,
          itemId: itemId.data,
          reviewContentRevision,
        });
        return json(
          exportHandoffsEnvelopeSchema.parse({
            data: {
              handoffs: ASSISTED_EXPORT_PLATFORMS.map(
                (platform) => view.handoffs[platform],
              ),
              pack: {
                effectivePrice: view.effectivePrice,
                reviewRevision: view.reviewRevision,
              },
            },
            meta: { requestId },
          }),
        );
      } catch (error) {
        dependencies.reportError?.("mobile-api.export-handoffs", error);
        return exportHandoffFailure(requestId, error);
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
          bearerToken: accountToken,
          handoff,
          idempotencyKey: idempotencyKey.data,
          targetUserId: principal.userId,
        });
        return json(
          guestClaimEnvelopeSchema.parse({
            data: outcome,
            meta: { requestId },
          }),
        );
      } catch (error) {
        // A denied claim is a conflict the caller can act on, not a server
        // fault to retry. The two allowance denials stay distinguishable
        // because "never" and "not right now" are different promises (#504).
        if (
          error instanceof GuestClaimInProgressError
          || error instanceof GuestClaimIdempotencyConflictError
          || error instanceof GuestClaimAllowanceSpentError
          || error instanceof GuestClaimAllowanceInFlightError
        ) {
          const reason = error instanceof GuestClaimAllowanceSpentError
            ? "guest_claim_allowance_spent"
            : error instanceof GuestClaimAllowanceInFlightError
              ? "guest_claim_allowance_in_flight"
              : error instanceof GuestClaimInProgressError
                ? "guest_claim_in_progress"
                : "guest_claim_idempotency_conflict";
          const claimStage = error instanceof GuestClaimAllowanceSpentError
              || error instanceof GuestClaimAllowanceInFlightError
            ? error.claimStage
            : undefined;
          return errorResponse(
            requestId,
            409,
            "conflict",
            error.message,
            { reason, ...(claimStage ? { claimStage } : {}) },
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

    // #524: the included first AI offer is fenced per physical device. Every
    // route here is proof-bound; the account always comes from authenticate().
    const includedOfferMatch = pathname.match(
      new RegExp(
        `^/${MOBILE_API_VERSION}/included-offer/redemptions(?:/([^/]+)(?:/(device-token))?)?$`,
      ),
    );
    if (includedOfferMatch) {
      const claimId = includedOfferMatch[1];
      const isRead = claimId !== undefined && includedOfferMatch[2] === undefined;
      if (request.method !== (isRead ? "GET" : "POST")) {
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
      // The redemption request is the only one without a claim to key on, so it
      // carries the caller's own key; the other two are keyed by the claim id.
      const idempotencyKey = claimId
        ? null
        : z
            .string()
            .uuid()
            .safeParse(request.headers.get("idempotency-key")?.trim());
      const parsedClaimId = claimId
        ? z.string().uuid().safeParse(claimId)
        : null;
      if (idempotencyKey?.success === false) {
        return errorResponse(
          requestId,
          400,
          "invalid_request",
          "A valid Idempotency-Key is required.",
        );
      }
      if (parsedClaimId?.success === false) {
        return errorResponse(
          requestId,
          400,
          "invalid_request",
          "A valid claim ID is required.",
        );
      }
      const { includedOffer } = dependencies;
      if (!includedOffer) {
        // Denying is the safe direction: an unconfigured fence must never let
        // an unfenced included run through to provider spend.
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "The included offer is not configured.",
        );
      }

      let principal: MobileApiPrincipal;
      try {
        principal = await dependencies.authenticate(token);
      } catch (error) {
        dependencies.reportError?.("mobile-api.included-offer-authenticate", error);
        return errorResponse(
          requestId,
          401,
          "unauthorized",
          "Authentication is required.",
        );
      }

      try {
        let outcome;
        if (parsedClaimId?.success && isRead) {
          outcome = await includedOffer.readClaim({
            claimId: parsedClaimId.data,
            userId: principal.userId,
          });
        } else {
          const body: unknown = await request.json();
          if (parsedClaimId?.success) {
            const parsed =
              includedOfferDeviceTokenRequestSchema.safeParse(body);
            if (!parsed.success) {
              return errorResponse(
                requestId,
                400,
                "invalid_request",
                "A fresh device token and App Attest assertion are required.",
              );
            }
            outcome = await includedOffer.submitDeviceToken({
              appAttest: parsed.data.appAttest,
              claimId: parsedClaimId.data,
              deviceToken: parsed.data.deviceToken,
              userId: principal.userId,
            });
          } else {
            const parsed = includedOfferRedeemRequestSchema.safeParse(body);
            if (!parsed.success || !idempotencyKey?.success) {
              return errorResponse(
                requestId,
                400,
                "invalid_request",
                "An App Attest assertion is required.",
              );
            }
            outcome = await includedOffer.redeem({
              appAttest: parsed.data.appAttest,
              idempotencyKey: idempotencyKey.data,
              userId: principal.userId,
            });
          }
        }
        return json(
          includedOfferEnvelopeSchema.parse({
            data: outcome,
            meta: { requestId },
          }),
          includedOfferHttpStatus(outcome),
        );
      } catch (error) {
        dependencies.reportError?.("mobile-api.included-offer", error);
        return errorResponse(
          requestId,
          503,
          "internal_error",
          "The included offer is temporarily unavailable.",
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
