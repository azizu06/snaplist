import type { PipelineWorker } from "@/lib/pipeline-queue/composition";
import {
  MOBILE_API_VERSION,
  apiErrorEnvelopeSchema,
  healthEnvelopeSchema,
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
   * Verifies issuer, audience, signature, expiry, and subject for the opaque
   * Clerk bearer JWT before returning the RLS identity. Runtime adapters own
   * the concrete verifier; request bodies never supply a user id.
   */
  authenticate(token: string): Promise<MobileApiPrincipal>;
  worker: PipelineWorker;
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
